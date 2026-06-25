const https = require('node:https');
const crypto = require('crypto');
const { Order, Product, StockMovement } = require('../models');
const logPayment = require('../utils/paymentLog');
const accounting = require('./accountingService');
const { sendOrderConfirmation } = require('./notificationService');

function getPaystackSecret() {
  return process.env.PAYSTACK_SECRET_KEY || '';
}

function verifyPaystackSignature(rawBody, signature) {
  const secret = getPaystackSecret();
  if (!secret || !signature) return false;
  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  return hash === signature;
}

function verifyPaystackTransaction(reference) {
  return new Promise((resolve, reject) => {
    const secret = getPaystackSecret();
    if (!secret) return reject(new Error('Paystack secret key not configured.'));

    const options = {
      hostname: 'api.paystack.co',
      path: `/transaction/verify/${encodeURIComponent(reference)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` },
    };

    let body = '';
    const req = https.request(options, (res) => {
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.data?.status === 'success') resolve(parsed.data);
          else reject(new Error(parsed.message || 'Payment verification failed.'));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Mark storefront orders paid, decrement stock, log payment, post GL.
 * Idempotent — skips orders that are already paid.
 */
async function fulfillStorefrontOrders({ reference, orderIds }) {
  let ids = orderIds;
  if (!ids?.length && reference) {
    const pending = await Order.find({ payment_ref: reference, payment_status: 'pending', source: 'storefront' });
    ids = pending.map((o) => o._id);
  }
  if (!ids?.length) return { order_numbers: [], fulfilled: 0 };

  const orderNumbers = [];
  for (const order_id of ids) {
    const order = await Order.findOne({ _id: order_id, payment_status: 'pending', source: 'storefront' });
    if (!order) continue;

    order.payment_status = 'paid';
    order.payment_ref = reference || order.payment_ref;
    order.payment_method = 'paystack';
    order.status = 'processing';
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
      description: `Storefront order ${order.order_number}`,
      source_id: order._id,
    });

    await accounting.postSaleEntry({
      tenantId: order.tenant_id,
      amount: order.total,
      cogsAmount: order.subtotal,
      taxAmount: order.tax_amount || 0,
      reference: order.order_number,
      date: new Date(),
      sourceId: order._id,
    }).catch(() => {});

    for (const item of order.items) {
      await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: -item.quantity } });
      await StockMovement.create({
        tenant_id: order.tenant_id,
        product_id: item.product_id,
        type: 'sale',
        quantity: -item.quantity,
        reference: order.order_number,
      });
    }

    await sendOrderConfirmation({
      tenantId: order.tenant_id,
      order,
      customerEmail: order.customer_email,
      customerPhone: order.customer_phone,
      channel: 'storefront',
    }).catch(() => {});

    if (order.coupon_code) {
      const { Coupon } = require('../models');
      const { applyCouponUsage } = require('./couponService');
      const coupon = await Coupon.findOne({ tenant_id: order.tenant_id, code: order.coupon_code });
      if (coupon) await applyCouponUsage(coupon._id);
    }
  }

  return { order_numbers: orderNumbers, fulfilled: orderNumbers.length };
}

async function failStorefrontOrders(orderIds) {
  if (!orderIds?.length) return;
  await Order.updateMany(
    { _id: { $in: orderIds }, payment_status: 'pending', source: 'storefront' },
    { payment_status: 'failed' }
  );
}

module.exports = {
  verifyPaystackSignature,
  verifyPaystackTransaction,
  fulfillStorefrontOrders,
  failStorefrontOrders,
};
