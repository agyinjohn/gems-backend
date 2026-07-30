const crypto = require('crypto');
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
    // Money Paystack collected, on any channel. paystack_settled covers both
    // storefront and POS; payment_method is the legacy fallback for storefront
    // orders written before that flag existed.
    $or: [{ paystack_settled: true }, { payment_method: 'paystack' }],
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
  // Reported as-is, including when negative. That happens when an order is
  // refunded after its takings were already paid out, and it means the tenant
  // owes the difference back — clamping it to zero would hide a real position.
  const available = round2(earned - withdrawn);

  return {
    currency: 'GHS',
    gross_sales: round2(gross),
    platform_fees: round2(fees),
    refunds: round2(refunds),
    earned,
    withdrawn,
    available,
    is_overdrawn: available < 0,
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
  // Random suffix as well as the timestamp: two payouts for the same tenant can
  // land in the same millisecond — most easily in the automatic per-order loop —
  // and a timestamp alone would collide on the unique index.
  const salt = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `PO-${String(tenantId).slice(-6)}-${Date.now().toString(36).toUpperCase()}-${salt}`;
}

const TERMINAL_STATUSES = ['paid', 'failed', 'reversed'];

/**
 * Free this scope's in-flight slot once the payout has settled one way or the
 * other, so the next withdrawal can be requested. Leaving it set would lock the
 * scope out permanently.
 */
function releaseIfSettled(payout) {
  if (TERMINAL_STATUSES.includes(payout.status)) payout.is_open = undefined;
}

/**
 * Record a payout and push the transfer to Paystack.
 *
 * The row is written before the transfer is attempted so a request can never
 * move money without leaving a trace. A rejected transfer is marked failed,
 * which releases the amount back into the available balance.
 */
async function createPayout({ tenantId, branchId, amount, method, trigger, userId }) {
  const isManual = (trigger || 'manual') === 'manual';

  let payout;
  try {
    payout = await Payout.create({
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
      // Claims this scope's single in-flight slot. Automatic payouts are left
      // unflagged so they never queue behind each other.
      ...(isManual && { is_open: true }),
    });
  } catch (err) {
    // The unique partial index rejected it: another withdrawal for this scope
    // is already in flight. This is the check that actually holds under
    // concurrent requests.
    if (err?.code === 11000) {
      const conflict = new Error('A payout is already being processed. Wait for it to complete before requesting another.');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  }

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
      releaseIfSettled(payout);
      await payout.save();
      return payout;
    }

    payout.transfer_code = result.data?.transfer_code;
    // Paystack returns "success" outright when OTP is disabled on the account;
    // otherwise it sits pending until the transfer.* webhook lands.
    payout.status = result.data?.status === 'success' ? 'paid' : 'processing';
    if (payout.status === 'paid') payout.completed_at = new Date();
    releaseIfSettled(payout);
    await payout.save();
    return payout;
  } catch (err) {
    payout.status = 'failed';
    payout.failure_reason = err.message || 'Transfer request failed.';
    releaseIfSettled(payout);
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
  releaseIfSettled(payout);
  await payout.save();
  return payout;
}

module.exports = {
  PAYOUT_OPEN_STATUSES,
  TERMINAL_STATUSES,
  getTenantPayoutSettings,
  getBalance,
  resolvePayoutMethod,
  createPayout,
  applyTransferWebhook,
  round2,
};
