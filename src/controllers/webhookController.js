const { Order } = require('../models');
const { verifyPaystackSignature, verifyPaystackTransaction, fulfillStorefrontOrders } = require('../services/paymentService');
const { fulfillPosPaystackOrder } = require('../services/posService');
const { failPendingPaystackOrder } = require('../services/posPendingService');

/**
 * POST /api/webhooks/paystack
 * Paystack server-to-server webhook (backup to client-side verify-payment).
 * Must receive raw JSON body for signature verification.
 */
const handlePaystackWebhook = async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).json({ success: false, message: 'Invalid webhook payload.' });
  }

  if (!(await verifyPaystackSignature(rawBody, signature))) {
    return res.status(401).json({ success: false, message: 'Invalid Paystack signature.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ success: false, message: 'Invalid JSON payload.' });
  }

  res.status(200).json({ success: true, received: true });

  const reference = event.data?.reference;

  // Transfer lifecycle — settles payouts we pushed to Paystack. A failed or
  // reversed transfer releases its amount back into the withdrawable balance.
  if (typeof event.event === 'string' && event.event.startsWith('transfer.')) {
    try {
      const { applyTransferWebhook } = require('../services/payoutService');
      await applyTransferWebhook({ event: event.event, data: event.data });
    } catch (err) {
      console.error(`[Webhook] Paystack ${event.event} failed:`, err.message);
    }
    return;
  }

  if (event.event === 'charge.failed' && reference) {
    try {
      const pendingPos = await Order.findOne({ payment_ref: reference, payment_status: 'pending', source: 'pos' })
        || (event.data?.metadata?.pos_order_id
          ? await Order.findOne({ _id: event.data.metadata.pos_order_id, payment_status: 'pending', source: 'pos' })
          : null);
      if (pendingPos) {
        await failPendingPaystackOrder({
          tenantId: pendingPos.tenant_id,
          order: pendingPos,
          reason: 'payment_failed',
          message: event.data?.gateway_response || 'Payment failed.',
        });
      }
    } catch (err) {
      console.error('[Webhook] Paystack charge.failed failed:', err.message);
    }
    return;
  }

  if (event.event !== 'charge.success') return;
  if (!reference) return;

  try {
    await verifyPaystackTransaction(reference);

    const pendingStorefront = await Order.find({ payment_ref: reference, payment_status: 'pending', source: 'storefront' });
    if (pendingStorefront.length) {
      await fulfillStorefrontOrders({ reference, orderIds: pendingStorefront.map((o) => o._id) });
    }

    const pendingPos = await Order.findOne({ payment_ref: reference, payment_status: 'pending', source: 'pos' })
      || (event.data?.metadata?.pos_order_id
        ? await Order.findOne({ _id: event.data.metadata.pos_order_id, payment_status: 'pending', source: 'pos' })
        : null);
    if (pendingPos) {
      await fulfillPosPaystackOrder({ reference, orderId: pendingPos._id });
    }
  } catch (err) {
    console.error('[Webhook] Paystack charge.success failed:', err.message);
  }
};

module.exports = { handlePaystackWebhook };
