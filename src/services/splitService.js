const { Tenant, PlatformSettings } = require('../models');

/**
 * Paystack payment splitting.
 *
 * A tenant that has connected a Paystack subaccount is paid at the gateway:
 * their share of each storefront payment settles straight to their own bank
 * account and only the platform's commission lands in the platform account.
 * Tenants without one keep collecting into the platform balance and
 * withdrawing from it — the two models coexist per tenant.
 *
 * Who gets what, per Paystack's rules:
 *   - `percentage_charge` on the subaccount is the share taken by the MAIN
 *     (platform) account. We create subaccounts at 0 so a plain storefront sale
 *     goes wholly to the tenant, matching how collect-then-remit behaves today.
 *   - `transaction_charge` is a flat amount, in pesewas, that goes to the MAIN
 *     account and overrides that percentage for the transaction. We set it per
 *     payment from the marketplace commission, so the platform earns on
 *     marketplace orders and nothing on direct ones.
 */

/** The tenant's connected subaccount, or null when they aren't split-enabled. */
async function getActiveSubaccount(tenantId) {
  const tenant = await Tenant.findById(tenantId).select('paystack_subaccount').lean();
  const sub = tenant?.paystack_subaccount;
  if (!sub?.subaccount_code || sub.is_active === false) return null;
  return sub;
}

async function getCommissionPct() {
  const settings = await PlatformSettings.findOne().select('marketplace_commission_pct').lean();
  return settings?.marketplace_commission_pct ?? 5;
}

/** Platform commission on an order — charged on marketplace orders only. */
function commissionFor({ amount, viaMarketplace, pct }) {
  if (!viaMarketplace) return 0;
  return Math.round(amount * (pct / 100) * 100) / 100;
}

/**
 * Split parameters for a checkout, or null when the tenant is not
 * split-enabled and the payment should collect into the platform balance.
 *
 * `amount` is the whole transaction total (a checkout can produce several
 * orders across branches but is paid for in one Paystack transaction), and
 * `commission` is the platform's cut of it.
 */
async function buildSplitForCheckout({ tenantId, amount, viaMarketplace }) {
  const sub = await getActiveSubaccount(tenantId);
  if (!sub) return null;

  const pct = await getCommissionPct();
  const commission = commissionFor({ amount, viaMarketplace, pct });

  return {
    subaccount: sub.subaccount_code,
    // Pesewas to the platform. Zero on direct storefront sales, which leaves
    // the tenant whole — the same split as collect-then-remit produces today.
    transaction_charge: Math.round(commission * 100),
    commission,
  };
}

module.exports = {
  getActiveSubaccount,
  getCommissionPct,
  commissionFor,
  buildSplitForCheckout,
};
