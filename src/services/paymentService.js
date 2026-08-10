const https = require('node:https');
const crypto = require('crypto');
const { Order, Product, StockMovement, PlatformSettings } = require('../models');
const logPayment = require('../utils/paymentLog');
const accounting = require('./accountingService');
const { sendOrderConfirmation } = require('./notificationService');

let cachedCredentials = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

function looksLikePlaceholderKey(key) {
  if (!key || typeof key !== 'string') return true;
  return /your_paystack|changeme|placeholder|xxx{3,}/i.test(key) || key.length < 24;
}

function isValidPaystackEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const value = email.trim().toLowerCase();
  if (!value || value.endsWith('.local')) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}

async function resolvePaystackEmail({ customerEmail, staffEmail, tenantEmail, reference }) {
  const candidates = [customerEmail, staffEmail, tenantEmail];
  for (const raw of candidates) {
    if (isValidPaystackEmail(raw)) return raw.trim().toLowerCase();
  }
  const { PlatformSettings } = require('../models');
  const settings = await PlatformSettings.findOne().lean();
  if (isValidPaystackEmail(settings?.support_email)) {
    return settings.support_email.trim().toLowerCase();
  }
  const safeRef = String(reference || Date.now()).replace(/[^a-z0-9]/gi, '').slice(0, 24) || 'sale';
  return `pos-${safeRef}@gthink.com`;
}

async function getPaystackCredentials() {
  if (cachedCredentials && Date.now() - cacheTime < CACHE_TTL_MS) return cachedCredentials;
  const { PlatformSettings } = require('../models');
  const settings = await PlatformSettings.findOne().lean();
  const publicKey = (settings?.paystack_public_key || process.env.PAYSTACK_PUBLIC_KEY || '').trim();
  const secretKey = (settings?.paystack_secret_key || process.env.PAYSTACK_SECRET_KEY || '').trim();
  cachedCredentials = { publicKey, secretKey };
  cacheTime = Date.now();
  return cachedCredentials;
}

function invalidatePaystackCredentialsCache() {
  cachedCredentials = null;
  cacheTime = 0;
}

function assertPaystackConfigured(credentials) {
  const { publicKey, secretKey } = credentials;
  if (looksLikePlaceholderKey(publicKey) || looksLikePlaceholderKey(secretKey)) {
    const err = new Error(
      'Paystack is not configured. Set PAYSTACK_PUBLIC_KEY and PAYSTACK_SECRET_KEY in gems-backend/.env (or Platform Settings).'
    );
    err.status = 500;
    throw err;
  }
  if (!publicKey.startsWith('pk_') || !secretKey.startsWith('sk_')) {
    const err = new Error('Paystack keys look invalid. Public keys start with pk_ and secret keys with sk_.');
    err.status = 500;
    throw err;
  }
}

function paystackRequest({ method, path, body, secretKey }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.paystack.co',
      path,
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    let responseBody = '';
    const req = https.request(options, (res) => {
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          if (parsed.status) resolve(parsed);
          else reject(new Error(parsed.message || 'Paystack request failed.'));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function initializePaystackTransaction({ email, amount, reference, channels, metadata, subaccount, transaction_charge }) {
  const credentials = await getPaystackCredentials();
  assertPaystackConfigured(credentials);

  const body = {
    email,
    amount: Math.round(amount * 100),
    currency: 'GHS',
    reference,
    channels,
  };
  if (metadata && Object.keys(metadata).length) {
    body.metadata = metadata;
  }
  // Split-enabled tenants: their share settles straight to their subaccount and
  // transaction_charge (pesewas) is the platform's cut of this transaction.
  if (subaccount) {
    body.subaccount = subaccount;
    body.transaction_charge = Math.round(transaction_charge || 0);
  }

  const parsed = await paystackRequest({
    method: 'POST',
    path: '/transaction/initialize',
    secretKey: credentials.secretKey,
    body,
  });

  if (!parsed.data?.access_code || !parsed.data?.authorization_url) {
    throw new Error(parsed.message || 'Could not initialize Paystack transaction.');
  }
  return parsed.data;
}

async function verifyPaystackSignature(rawBody, signature) {
  const { secretKey } = await getPaystackCredentials();
  if (!secretKey || !signature) return false;
  const hash = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  return hash === signature;
}

async function verifyPaystackTransaction(reference) {
  const { secretKey } = await getPaystackCredentials();
  if (!secretKey || looksLikePlaceholderKey(secretKey)) {
    throw new Error('Paystack secret key not configured.');
  }

  const parsed = await paystackRequest({
    method: 'GET',
    path: `/transaction/verify/${encodeURIComponent(reference)}`,
    secretKey,
  });

  if (parsed.data?.status === 'success' && parsed.data?.paid_at) return parsed.data;
  throw new Error(parsed.message || 'Payment verification failed.');
}

function isPaystackTransactionPaid(tx, expectedTotalGhs, expectedOrderId) {
  if (!tx || tx.status !== 'success' || !tx.paid_at) return false;

  const expectedKobo = Math.round(Number(expectedTotalGhs) * 100);
  if (expectedKobo > 0 && Number(tx.amount) !== expectedKobo) return false;

  const metaOrderId = tx.metadata?.pos_order_id || tx.metadata?.custom_fields?.find?.(
    (f) => f.variable_name === 'pos_order_id',
  )?.value;
  if (expectedOrderId && metaOrderId && String(metaOrderId) !== String(expectedOrderId)) {
    return false;
  }

  return true;
}

async function fetchPaystackTransaction(reference) {
  const { secretKey } = await getPaystackCredentials();
  if (!secretKey || looksLikePlaceholderKey(secretKey)) {
    throw new Error('Paystack secret key not configured.');
  }

  const parsed = await paystackRequest({
    method: 'GET',
    path: `/transaction/verify/${encodeURIComponent(reference)}`,
    secretKey,
  });

  return parsed.data || null;
}

/**
 * Mark storefront orders paid, decrement stock, log payment, post GL.
 * Idempotent — skips orders that are already paid.
 */
async function fulfillStorefrontOrders({ reference, orderIds }) {
  let ids = orderIds;
  if (!ids?.length && reference) {
    const pending = await Order.find({
      payment_ref: reference,
      payment_status: { $in: ['pending', 'failed'] },
      source: { $in: ['storefront', 'service_request'] },
    });
    ids = pending.map((o) => o._id);
  }
  if (!ids?.length) return { order_numbers: [], fulfilled: 0 };

  const orderNumbers = [];
  for (const order_id of ids) {
    const order = await Order.findOne({
      _id: order_id,
      payment_status: { $in: ['pending', 'failed'] },
      source: { $in: ['storefront', 'service_request'] },
    });
    if (!order) continue;
    const isServiceRequest = order.source === 'service_request';

    order.payment_status = 'paid';
    order.payment_ref = reference || order.payment_ref;
    order.payment_method = 'paystack';
    order.paystack_settled = true;
    // A service request's own stage is tracked separately and must not be
    // reset by payment landing — a job can be paid for while it is already on
    // the press, or halfway through a repair.
    if (!isServiceRequest) order.status = 'processing';
    // Split-settled orders had their commission taken at the gateway and
    // stamped on the order at checkout — don't recompute it here.
    if (order.via_marketplace && !order.split_settled) {
      const settings = await PlatformSettings.findOne().select('marketplace_commission_pct').lean();
      const pct = settings?.marketplace_commission_pct ?? 5;
      order.platform_fee = Math.round(order.total * (pct / 100) * 100) / 100;
    }
    await order.save();

    orderNumbers.push(order.order_number);

    await logPayment({
      tenant_id: order.tenant_id,
      source: 'storefront',
      reference: order.order_number,
      amount: order.total,
      method: 'paystack',
      status: 'success',
      payer_name: order.customer_name,
      payer_email: order.customer_email,
      description: `${isPrint ? 'Print job' : 'Storefront order'} ${order.order_number}`,
      source_id: order._id,
    });

    const hasProduct = order.items.some((i) => i.item_type !== 'service');
    const hasService = order.items.some((i) => i.item_type === 'service');
    const revenueAccountCode = hasProduct ? '4001' : hasService ? '4010' : '4001';
    await accounting.postSaleEntry({
      tenantId: order.tenant_id,
      amount: order.total,
      cogsAmount: order.subtotal,
      taxAmount: order.tax_amount || 0,
      reference: order.order_number,
      date: new Date(),
      sourceId: order._id,
      revenueAccountCode,
    }).catch(() => {});

    for (const item of order.items) {
      // Deduct stock: bundles deduct each component, services skip
      if (item.item_type === 'bundle') {
        const bundle = await Product.findById(item.product_id).lean();
        if (bundle?.bundle_items?.length) {
          for (const comp of bundle.bundle_items) {
            const needed = comp.quantity * item.quantity;
            await Product.findByIdAndUpdate(comp.product_id, { $inc: { stock_qty: -needed } });
            await StockMovement.create({
              tenant_id:  order.tenant_id,
              product_id: comp.product_id,
              type:       'sale',
              quantity:   -needed,
              reference:  order.order_number,
              notes:      `Bundle: ${bundle.name}`,
            });
          }
        }
      } else if (item.item_type !== 'service') {
        await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: -item.quantity } });
        await StockMovement.create({
          tenant_id:  order.tenant_id,
          product_id: item.product_id,
          type:       'sale',
          quantity:   -item.quantity,
          reference:  order.order_number,
        });
      }
    }

    await sendOrderConfirmation({
      tenantId: order.tenant_id,
      order,
      customerEmail: order.customer_email,
      customerPhone: order.customer_phone,
      channel: 'storefront',
    }).catch(() => {});

    // Split-settled orders already paid the tenant at the gateway; there is
    // nothing in the platform balance to send on. Otherwise push the takings
    // straight out only when the tenant has opted into automatic payouts —
    // they stay withdrawable on request by default (see payoutService).
    if (!order.split_settled) {
      await triggerStorefrontPayout(
        order.tenant_id,
        order.total - (order.platform_fee || 0),
        order.order_number,
        order.branch_id,
      );
    }

    if (order.coupon_code) {
      const { Coupon } = require('../models');
      const { applyCouponUsage } = require('./couponService');
      const coupon = await Coupon.findOne({ tenant_id: order.tenant_id, code: order.coupon_code });
      if (coupon) await applyCouponUsage(coupon._id);
    }
  }

  return { order_numbers: orderNumbers, fulfilled: orderNumbers.length };
}

/**
 * Automatic per-order payout.
 *
 * Only runs for tenants who have opted into payout_settings.auto_payout; by
 * default takings accumulate as a withdrawable balance instead. Either way the
 * transfer is recorded as a Payout row so the balance calculation stays
 * correct regardless of which path moved the money.
 */
async function triggerStorefrontPayout(tenantId, amount, reference, branchId = null) {
  try {
    // Required lazily — payoutService imports this module for Paystack access.
    const payoutService = require('./payoutService');

    const settings = await payoutService.getTenantPayoutSettings(tenantId);
    if (!settings.auto_payout) return; // balance accrues for manual withdrawal

    if (!(amount > 0)) return;

    const method = await payoutService.resolvePayoutMethod({
      tenantId,
      branchId,
      perBranchMethods: settings.per_branch_methods,
    });
    if (!method) return; // no payout method configured — skip silently

    await payoutService.createPayout({
      tenantId,
      branchId,
      amount,
      method,
      trigger: 'auto',
    });
  } catch (err) {
    console.error('[Payout] Transfer failed for', reference, err.message);
  }
}

async function failStorefrontOrders(orderIds) {
  if (!orderIds?.length) return;
  await Order.updateMany(
    { _id: { $in: orderIds }, payment_status: 'pending', source: 'storefront' },
    { payment_status: 'failed' }
  );
}

module.exports = {
  getPaystackCredentials,
  assertPaystackConfigured,
  isValidPaystackEmail,
  resolvePaystackEmail,
  initializePaystackTransaction,
  invalidatePaystackCredentialsCache,
  paystackRequest,
  verifyPaystackSignature,
  verifyPaystackTransaction,
  fetchPaystackTransaction,
  isPaystackTransactionPaid,
  fulfillStorefrontOrders,
  failStorefrontOrders,
  triggerStorefrontPayout,
};
