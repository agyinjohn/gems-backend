const { Order } = require('../models');
const { fetchPaystackTransaction } = require('./paymentService');
const { fulfillPosPaystackOrder } = require('./posService');
const { releaseStockForItems, mapOrderItems } = require('./posReservationService');
const {
  listPendingPaystackOrders,
  clearCustomerDisplayByOrderId,
  getDisplayQueue,
} = require('./posDisplayService');

const PAYSTACK_CHECK_MIN_AGE_MS = 12 * 1000;
const FAILED_PAYSTACK_STATUSES = new Set(['failed', 'reversed', 'abandoned', 'cancelled']);

async function failPendingPaystackOrder({ tenantId, order, reason, message }) {
  if (!order || order.payment_status !== 'pending') return null;

  await releaseStockForItems({ tenantId, items: mapOrderItems(order) });
  order.payment_status = 'failed';
  order.payment_failure_reason = reason;
  order.status = 'cancelled';
  await order.save();
  await clearCustomerDisplayByOrderId(order._id);

  return {
    type: reason === 'expired' ? 'expired' : 'failed',
    order_id: String(order._id),
    order_number: order.order_number,
    customer_name: order.customer_name,
    total: order.total,
    message: message || (reason === 'expired' ? 'Payment window expired.' : 'Payment failed.'),
    reason,
  };
}

async function expireStalePendingOrders({ tenantId, userId, shiftId }) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const orConditions = [{ created_by: userId, createdAt: { $gte: since } }];
  if (shiftId) orConditions.push({ shift_id: shiftId });

  const stale = await Order.find({
    tenant_id: tenantId,
    source: 'pos',
    payment_status: 'pending',
    pending_expires_at: { $lt: new Date() },
    $or: orConditions,
  });

  const events = [];
  for (const order of stale) {
    const ev = await failPendingPaystackOrder({
      tenantId,
      order,
      reason: 'expired',
      message: 'Customer did not pay in time. Stock released.',
    });
    if (ev) events.push(ev);
  }
  return events;
}

async function syncPendingPaystackOrders({ tenantId, userId, branchId, shiftId }) {
  const events = [];

  events.push(...await expireStalePendingOrders({ tenantId, userId, shiftId }));

  const pendingOrders = await Order.find({
    tenant_id: tenantId,
    source: 'pos',
    payment_status: 'pending',
    payment_method: { $in: ['card', 'card_terminal', 'momo'] },
    $or: [
      { created_by: userId, createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      ...(shiftId ? [{ shift_id: shiftId }] : []),
    ],
  }).sort({ createdAt: -1 }).limit(30);

  const now = Date.now();

  for (const order of pendingOrders) {
    if (!order.payment_ref) continue;
    if (now - new Date(order.createdAt).getTime() < PAYSTACK_CHECK_MIN_AGE_MS) continue;

    let tx;
    try {
      tx = await fetchPaystackTransaction(order.payment_ref);
    } catch {
      continue;
    }

    if (tx?.status === 'success') {
      try {
        const result = await fulfillPosPaystackOrder({
          tenantId,
          orderId: order._id,
          reference: order.payment_ref,
          userId,
          branchId,
        });
        events.push({
          type: 'completed',
          order_id: String(order._id),
          order_number: result.order.order_number,
          customer_name: order.customer_name,
          total: order.total,
        });
      } catch (err) {
        if (err.message?.includes('Insufficient stock')) {
          const ev = await failPendingPaystackOrder({
            tenantId,
            order: await Order.findById(order._id),
            reason: 'insufficient_stock',
            message: 'Payment received but items no longer available. Refund customer on Paystack.',
          });
          if (ev) events.push({ ...ev, reason: 'insufficient_stock' });
        }
      }
      continue;
    }

    if (FAILED_PAYSTACK_STATUSES.has(tx?.status)) {
      const ev = await failPendingPaystackOrder({
        tenantId,
        order,
        reason: 'payment_failed',
        message: tx.gateway_response || 'Payment was declined or cancelled.',
      });
      if (ev) events.push(ev);
    }
  }

  const pending = await listPendingPaystackOrders({ tenantId, userId, shiftId });
  const queue = await getDisplayQueue({ tenantId, branchId });

  return { pending, events, queue };
}

module.exports = {
  failPendingPaystackOrder,
  expireStalePendingOrders,
  syncPendingPaystackOrders,
  PENDING_ORDER_TTL_MS: 30 * 60 * 1000,
};
