const mongoose = require('mongoose');
const { Order, Payout, PayoutMethod, Tenant } = require('../models');
const { paystackRequest, getPaystackCredentials } = require('./paymentService');

/**
 * Payouts.
 *
 * Money reaches the platform's Paystack balance through Paystack-paid orders
 * (storefront checkout and POS virtual-terminal). What a tenant may withdraw is
 * therefore derived, not stored:
 *
 *   available = takings − payouts already out the door
 *
 *   takings = Σ (total − platform_fee − refund_amount)   over paid Paystack orders
 *   out     = Σ amount                                    over payouts not failed/reversed
 *
 * Deriving it this way means a failed transfer releases its funds automatically
 * (the row stops counting) and there is no separate balance field to drift.
 * Cash and other non-Paystack takings are excluded — that money never reached
 * Paystack, so it cannot be transferred out of it.
 */

const PAYOUT_OPEN_STATUSES = ['pending', 'processing', 'paid'];

/** Scope filter for a request: branch users are pinned, org users see all/one. */
function scopeFilter(req) {
  return { tenant_id: req.tenant_id, ...(req.branchFilter || {}) };
}

async function getTenantPayoutSettings(tenantId) {
  const tenant = await Tenant.findById(tenantId).select('payout_settings').lean();
  return {
    auto_payout: tenant?.payout_settings?.auto_payout ?? false,
    per_branch_methods: tenant?.payout_settings?.per_branch_methods ?? false,
    min_payout_amount: tenant?.payout_settings?.min_payout_amount ?? 10,
  };
}

/**
 * Withdrawable balance for a tenant, optionally narrowed to one branch.
 * `branchFilter` is the resolved scope ({} = whole organisation).
 */
async function getBalance({ tenantId, branchFilter = {} }) {
  const takingsMatch = {
    tenant_id: new mongoose.Types.ObjectId(tenantId),
    payment_status: 'paid',
    payment_method: 'paystack',
    // Split-settled orders paid the tenant directly at the gateway, so that
    // money is not in the platform balance and must never be withdrawable.
    split_settled: { $ne: true },
    ...branchFilter,
  };

  const [takingsRow] = await Order.aggregate([
    { $match: takingsMatch },
    {
      $group: {
        _id: null,
        gross: { $sum: '$total' },
        fees: { $sum: { $ifNull: ['$platform_fee', 0] } },
        refunds: { $sum: { $ifNull: ['$refund_amount', 0] } },
        orders: { $sum: 1 },
      },
    },
  ]);

  const [outRow] = await Payout.aggregate([
    {
      $match: {
        tenant_id: new mongoose.Types.ObjectId(tenantId),
        status: { $in: PAYOUT_OPEN_STATUSES },
        ...branchFilter,
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  const gross = takingsRow?.gross || 0;
  const fees = takingsRow?.fees || 0;
  const refunds = takingsRow?.refunds || 0;
  const earned = round2(gross - fees - refunds);
  const withdrawn = round2(outRow?.total || 0);

  return {
    currency: 'GHS',
    gross_sales: round2(gross),
    platform_fees: round2(fees),
    refunds: round2(refunds),
    earned,
    withdrawn,
    available: round2(Math.max(earned - withdrawn, 0)),
    order_count: takingsRow?.orders || 0,
    payout_count: outRow?.count || 0,
  };
}

/**
 * Pick the destination for a payout.
 *
 * With per-branch methods on, a branch's own default is preferred and the
 * organisation-wide default is the fallback. With it off, only org-wide
 * methods are considered — one account for the whole business.
 */
async function resolvePayoutMethod({ tenantId, branchId, perBranchMethods, methodId }) {
  if (methodId) {
    const chosen = await PayoutMethod.findOne({ _id: methodId, tenant_id: tenantId, is_active: true });
    if (!chosen) return null;
    // A branch-scoped method may only be used for that branch.
    if (chosen.branch_id && String(chosen.branch_id) !== String(branchId || '')) return null;
    return chosen;
  }

  if (perBranchMethods && branchId) {
    const branchDefault = await PayoutMethod.findOne({ tenant_id: tenantId, branch_id: branchId, is_active: true })
      .sort({ is_default: -1, createdAt: -1 });
    if (branchDefault) return branchDefault;
  }

  return PayoutMethod.findOne({ tenant_id: tenantId, branch_id: null, is_active: true })
    .sort({ is_default: -1, createdAt: -1 });
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

function buildReference(tenantId) {
  return `PO-${String(tenantId).slice(-6)}-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Record a payout and push the transfer to Paystack.
 *
 * The row is written before the transfer is attempted so a request can never
 * move money without leaving a trace. A rejected transfer is marked failed,
 * which releases the amount back into the available balance.
 */
async function createPayout({ tenantId, branchId, amount, method, trigger, userId }) {
  const payout = await Payout.create({
    tenant_id: tenantId,
    branch_id: branchId || null,
    amount: round2(amount),
    status: 'pending',
    trigger: trigger || 'manual',
    payout_method_id: method._id,
    method_label: method.label,
    recipient_code: method.recipient_code,
    reference: buildReference(tenantId),
    requested_by: userId || null,
  });

  try {
    const { secretKey } = await getPaystackCredentials();
    const result = await paystackRequest({
      method: 'POST',
      path: '/transfer',
      body: {
        source: 'balance',
        amount: Math.round(round2(amount) * 100), // pesewas
        recipient: method.recipient_code,
        reason: `Payout ${payout.reference}`,
        reference: payout.reference,
        currency: 'GHS',
      },
      secretKey,
    });

    if (!result?.status) {
      payout.status = 'failed';
      payout.failure_reason = result?.message || 'Paystack rejected the transfer.';
      await payout.save();
      return payout;
    }

    payout.transfer_code = result.data?.transfer_code;
    // Paystack returns "success" outright when OTP is disabled on the account;
    // otherwise it sits pending until the transfer.* webhook lands.
    payout.status = result.data?.status === 'success' ? 'paid' : 'processing';
    if (payout.status === 'paid') payout.completed_at = new Date();
    await payout.save();
    return payout;
  } catch (err) {
    payout.status = 'failed';
    payout.failure_reason = err.message || 'Transfer request failed.';
    await payout.save();
    return payout;
  }
}

/** Apply a Paystack transfer.* webhook to its payout row. */
async function applyTransferWebhook({ event, data }) {
  const query = data?.reference
    ? { reference: data.reference }
    : (data?.transfer_code ? { transfer_code: data.transfer_code } : null);
  if (!query) return null;

  const payout = await Payout.findOne(query);
  if (!payout) return null;

  if (event === 'transfer.success') {
    payout.status = 'paid';
    payout.completed_at = new Date();
    payout.failure_reason = undefined;
  } else if (event === 'transfer.failed') {
    payout.status = 'failed';
    payout.failure_reason = data?.reason || data?.message || 'Transfer failed.';
  } else if (event === 'transfer.reversed') {
    payout.status = 'reversed';
    payout.failure_reason = data?.reason || data?.message || 'Transfer reversed.';
  } else {
    return payout;
  }

  if (!payout.transfer_code && data?.transfer_code) payout.transfer_code = data.transfer_code;
  await payout.save();
  return payout;
}

module.exports = {
  PAYOUT_OPEN_STATUSES,
  scopeFilter,
  getTenantPayoutSettings,
  getBalance,
  resolvePayoutMethod,
  createPayout,
  applyTransferWebhook,
  round2,
};
