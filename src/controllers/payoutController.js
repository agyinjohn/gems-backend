const mongoose = require('mongoose');
const { PayoutMethod, Payout, Tenant, Branch } = require('../models');
const { paystackRequest, getPaystackCredentials } = require('../services/paymentService');
const payoutService = require('../services/payoutService');

// GHS mobile money network codes (Paystack)
const MOMO_NETWORKS = {
  mtn: 'MTN',
  vodafone: 'VOD',
  airteltigo: 'ATL',
};

const isOwner = (req) => ['platform_admin', 'business_owner'].includes(req.user.role);

/**
 * Which branch a write applies to.
 *
 * Branch-bound users are pinned to their own branch and cannot name another.
 * Org-level users may target a branch explicitly, or null for organisation-wide.
 */
function resolveTargetBranch(req, requested) {
  if (req.user.branch_id) return { branchId: req.user.branch_id };
  if (requested === undefined || requested === null || requested === '' || requested === 'all') {
    return { branchId: null };
  }
  if (!mongoose.Types.ObjectId.isValid(requested)) return { error: 'Invalid branch_id.' };
  return { branchId: new mongoose.Types.ObjectId(requested) };
}

/* ── Payout methods ───────────────────────────────────────────────────────── */

const list = async (req, res) => {
  const { per_branch_methods } = await payoutService.getTenantPayoutSettings(req.tenant_id);

  // A branch user sees the methods they can actually be paid through: their
  // own branch's, plus the org-wide ones that serve every branch.
  const filter = { tenant_id: req.tenant_id, is_active: true };
  if (req.user.branch_id) {
    filter.$or = [{ branch_id: req.user.branch_id }, { branch_id: null }];
  } else if (req.branchId) {
    filter.$or = [{ branch_id: req.branchId }, { branch_id: null }];
  }

  const methods = await PayoutMethod.find(filter)
    .populate('branch_id', 'name')
    .sort({ is_default: -1, createdAt: -1 });

  res.json({ success: true, data: methods, settings: { per_branch_methods } });
};

const create = async (req, res) => {
  const { type, account_number, account_name, bank_code, branch_id } = req.body;
  if (!type || !account_number || !account_name || !bank_code) {
    return res.status(400).json({ success: false, message: 'type, account_number, account_name and bank_code are required.' });
  }

  const { branchId, error } = resolveTargetBranch(req, branch_id);
  if (error) return res.status(400).json({ success: false, message: error });

  if (branchId) {
    const branch = await Branch.findOne({ _id: branchId, tenant_id: req.tenant_id });
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found.' });
  }

  const { secretKey } = await getPaystackCredentials();

  // Create Paystack transfer recipient
  const recipientPayload = {
    type: type === 'mobile_money' ? 'mobile_money' : 'ghipss',
    name: account_name,
    account_number,
    bank_code,
    currency: 'GHS',
  };

  const result = await paystackRequest({ method: 'POST', path: '/transferrecipient', body: recipientPayload, secretKey });
  if (!result.status) {
    return res.status(400).json({ success: false, message: result.message || 'Failed to create Paystack recipient.' });
  }

  const recipient_code = result.data.recipient_code;
  const networkLabel = type === 'mobile_money'
    ? (Object.entries(MOMO_NETWORKS).find(([, v]) => v === bank_code)?.[0]?.toUpperCase() || bank_code)
    : bank_code;
  const label = `${networkLabel} — ${account_number.slice(-4).padStart(account_number.length, '*')}`;

  // First method in its own scope becomes that scope's default.
  const existingCount = await PayoutMethod.countDocuments({ tenant_id: req.tenant_id, branch_id: branchId, is_active: true });

  const method = await PayoutMethod.create({
    tenant_id: req.tenant_id,
    branch_id: branchId,
    type,
    label,
    recipient_code,
    account_number,
    account_name,
    bank_code,
    is_default: existingCount === 0,
  });

  res.status(201).json({ success: true, data: method });
};

const setDefault = async (req, res) => {
  const { id } = req.params;
  const method = await PayoutMethod.findOne({ _id: id, tenant_id: req.tenant_id, is_active: true });
  if (!method) return res.status(404).json({ success: false, message: 'Payout method not found.' });

  // Branch users may only promote a method that pays out to their own branch.
  if (req.user.branch_id && String(method.branch_id || '') !== String(req.user.branch_id)) {
    return res.status(403).json({ success: false, message: 'You can only manage your own branch payout methods.' });
  }

  // Default is per scope — one org-wide default, one default per branch.
  await PayoutMethod.updateMany({ tenant_id: req.tenant_id, branch_id: method.branch_id || null }, { is_default: false });
  method.is_default = true;
  await method.save();

  res.json({ success: true, data: method });
};

const remove = async (req, res) => {
  const { id } = req.params;
  const existing = await PayoutMethod.findOne({ _id: id, tenant_id: req.tenant_id, is_active: true });
  if (!existing) return res.status(404).json({ success: false, message: 'Payout method not found.' });

  if (req.user.branch_id && String(existing.branch_id || '') !== String(req.user.branch_id)) {
    return res.status(403).json({ success: false, message: 'You can only manage your own branch payout methods.' });
  }

  existing.is_active = false;
  await existing.save();

  // If the removed method was the default, promote the next one in that scope.
  if (existing.is_default) {
    const next = await PayoutMethod.findOne({
      tenant_id: req.tenant_id,
      branch_id: existing.branch_id || null,
      is_active: true,
    }).sort({ createdAt: -1 });
    if (next) {
      next.is_default = true;
      await next.save();
    }
  }

  res.json({ success: true });
};

/* ── Balance & withdrawals ────────────────────────────────────────────────── */

const balance = async (req, res) => {
  const settings = await payoutService.getTenantPayoutSettings(req.tenant_id);
  const data = await payoutService.getBalance({
    tenantId: req.tenant_id,
    branchFilter: req.branchFilter || {},
  });

  const method = await payoutService.resolvePayoutMethod({
    tenantId: req.tenant_id,
    branchId: req.user.branch_id || req.branchId || null,
    perBranchMethods: settings.per_branch_methods,
  });

  res.json({
    success: true,
    data: {
      ...data,
      settings,
      scope: {
        is_org_level: !!req.isOrgLevel && !req.branchId,
        branch_id: req.user.branch_id || req.branchId || null,
      },
      destination: method
        ? { id: method._id, label: method.label, account_name: method.account_name, branch_id: method.branch_id }
        : null,
    },
  });
};

const listPayouts = async (req, res) => {
  const payouts = await Payout.find({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) })
    .populate('branch_id', 'name')
    .populate('requested_by', 'name')
    .sort({ createdAt: -1 })
    .limit(100);
  res.json({ success: true, data: payouts });
};

/**
 * Request a withdrawal of collected takings.
 *
 * Business owners may withdraw organisation-wide or for a chosen branch;
 * branch managers are pinned to their own branch by branch scoping.
 */
const requestPayout = async (req, res) => {
  const { amount, method_id, branch_id } = req.body;

  // Only an owner may draw on the whole organisation. A branch manager with no
  // branch assigned would otherwise fall through to organisation-wide scope and
  // be able to withdraw the entire business's money.
  if (!isOwner(req) && !req.user.branch_id) {
    return res.status(403).json({
      success: false,
      message: 'You need to be assigned to a branch before you can request a payout.',
    });
  }

  const { branchId, error } = resolveTargetBranch(req, branch_id);
  if (error) return res.status(400).json({ success: false, message: error });

  const settings = await payoutService.getTenantPayoutSettings(req.tenant_id);

  // Balance is scoped the same way the withdrawal is: a branch withdrawal may
  // only draw on that branch's takings.
  const branchFilter = branchId ? { branch_id: branchId } : (req.branchFilter || {});
  const bal = await payoutService.getBalance({ tenantId: req.tenant_id, branchFilter });

  // Branch balances are sub-ledgers of one shared Paystack pot, so a branch
  // withdrawal is also capped by what the whole organisation has left —
  // otherwise concurrent branch requests could together overdraw it.
  const orgBal = branchId || req.user.branch_id
    ? await payoutService.getBalance({ tenantId: req.tenant_id, branchFilter: {} })
    : bal;
  const ceiling = Math.min(bal.available, orgBal.available);

  const requested = amount === undefined || amount === null || amount === ''
    ? ceiling
    : payoutService.round2(Number(amount));

  if (!Number.isFinite(requested) || requested <= 0) {
    return res.status(400).json({ success: false, message: 'Enter a valid amount to withdraw.' });
  }
  if (requested < settings.min_payout_amount) {
    return res.status(400).json({
      success: false,
      message: `The minimum payout is GHS ${settings.min_payout_amount.toFixed(2)}.`,
    });
  }
  if (requested > ceiling) {
    return res.status(400).json({
      success: false,
      message: `Only GHS ${ceiling.toFixed(2)} is available to withdraw.`,
    });
  }

  const method = await payoutService.resolvePayoutMethod({
    tenantId: req.tenant_id,
    branchId,
    perBranchMethods: settings.per_branch_methods,
    methodId: method_id,
  });
  if (!method) {
    return res.status(400).json({
      success: false,
      message: 'No payout method is set up for this account. Add one before requesting a payout.',
    });
  }

  // Two withdrawals on one scope are rejected by a unique index inside
  // createPayout rather than a prior lookup, so simultaneous requests can't
  // both get through.
  let payout;
  try {
    payout = await payoutService.createPayout({
      tenantId: req.tenant_id,
      branchId,
      amount: requested,
      method,
      trigger: 'manual',
      userId: req.user.id || req.user._id,
    });
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ success: false, message: err.message });
    throw err;
  }

  if (payout.status === 'failed') {
    return res.status(400).json({
      success: false,
      message: payout.failure_reason || 'The transfer could not be completed.',
      data: payout,
    });
  }

  res.status(201).json({ success: true, data: payout });
};

/* ── Settings ─────────────────────────────────────────────────────────────── */

const getSettings = async (req, res) => {
  const settings = await payoutService.getTenantPayoutSettings(req.tenant_id);
  res.json({ success: true, data: settings });
};

const updateSettings = async (req, res) => {
  if (!isOwner(req)) {
    return res.status(403).json({ success: false, message: 'Only a business owner can change payout settings.' });
  }

  const { auto_payout, per_branch_methods, min_payout_amount } = req.body;
  const update = {};
  if (auto_payout !== undefined) update['payout_settings.auto_payout'] = !!auto_payout;
  if (per_branch_methods !== undefined) update['payout_settings.per_branch_methods'] = !!per_branch_methods;
  if (min_payout_amount !== undefined) {
    const min = Number(min_payout_amount);
    if (!Number.isFinite(min) || min < 0) {
      return res.status(400).json({ success: false, message: 'min_payout_amount must be a positive number.' });
    }
    update['payout_settings.min_payout_amount'] = min;
  }

  if (!Object.keys(update).length) {
    return res.status(400).json({ success: false, message: 'Nothing to update.' });
  }

  await Tenant.findByIdAndUpdate(req.tenant_id, { $set: update });
  const settings = await payoutService.getTenantPayoutSettings(req.tenant_id);
  res.json({ success: true, data: settings });
};

module.exports = {
  list,
  create,
  setDefault,
  remove,
  balance,
  listPayouts,
  requestPayout,
  getSettings,
  updateSettings,
};
