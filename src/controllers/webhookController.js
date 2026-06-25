const { Order } = require('../models');
const { verifyPaystackSignature, verifyPaystackTransaction, fulfillStorefrontOrders } = require('../services/paymentService');

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

  if (!verifyPaystackSignature(rawBody, signature)) {
    return res.status(401).json({ success: false, message: 'Invalid Paystack signature.' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ success: false, message: 'Invalid JSON payload.' });
  }

  // Always acknowledge quickly so Paystack does not retry unnecessarily
  res.status(200).json({ success: true, received: true });

  if (event.event !== 'charge.success') return;

  const reference = event.data?.reference;
  if (!reference) return;

  try {
    await verifyPaystackTransaction(reference);

    // Storefront orders store the Paystack reference at checkout
    const pendingOrders = await Order.find({ payment_ref: reference, payment_status: 'pending', source: 'storefront' });
    if (pendingOrders.length) {
      await fulfillStorefrontOrders({ reference, orderIds: pendingOrders.map((o) => o._id) });
    }
  } catch (err) {
    console.error('[Webhook] Paystack charge.success failed:', err.message);
  }
};

module.exports = { handlePaystackWebhook };
