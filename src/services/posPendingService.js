const { Order } = require('../models');
const { fetchPaystackTransaction, isPaystackTransactionPaid } = require('./paymentService');
const { fulfillPosPaystackOrder } = require('./posService');
const { releaseStockForItems, mapOrderItems } = require('./posReservationService');
const {
  listPendingPaystackOrders,
  getDisplayQueue,
  clearCustomerDisplayByOrderId,
} = require('./posDisplayService');

const PAYSTACK_CHECK_MIN_AGE_MS = 45 * 1000;
/** Only hard-fail on Paystack statuses that mean the charge will not complete. */
const FAILED_PAYSTACK_STATUSES = new Set(['failed', 'reversed']);

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
  const eventKeys = new Set();

  const pushEvent = (ev) => {
    if (!ev) return;
    const key = `${ev.type}:${ev.order_id}`;
    if (eventKeys.has(key)) return;
    eventKeys.add(key);
    events.push(ev);
  };

  for (const ev of await expireStalePendingOrders({ tenantId, userId, shiftId })) {
    pushEvent(ev);
  }

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

    if (!tx) continue;

    if (isPaystackTransactionPaid(tx, order.total, order._id)) {
      try {
        const result = await fulfillPosPaystackOrder({
          tenantId,
          orderId: order._id,
          reference: order.payment_ref,
          userId,
          branchId,
        });
        if (!result.already_fulfilled) {
          pushEvent({
            type: 'completed',
            order_id: String(order._id),
            order_number: result.order.order_number,
            customer_name: order.customer_name,
            total: order.total,
          });
        }
      } catch (err) {
        if (err.message?.includes('Insufficient stock')) {
          const fresh = await Order.findById(order._id);
          const ev = await failPendingPaystackOrder({
            tenantId,
            order: fresh,
            reason: 'insufficient_stock',
            message: 'Payment received but items no longer available. Refund customer on Paystack.',
          });
          if (ev) pushEvent({ ...ev, reason: 'insufficient_stock' });
        }
      }
      continue;
    }

    if (FAILED_PAYSTACK_STATUSES.has(tx?.status)) {
      const ev = await failPendingPaystackOrder({
        tenantId,
        order,
        reason: 'payment_failed',
        message: tx.gateway_response || 'Payment was declined.',
      });
      pushEvent(ev);
    }
  }

  const pending = await listPendingPaystackOrders({ tenantId, userId, shiftId });
  const display = await getDisplayQueue({ tenantId, branchId });

  return { pending, events, queue: display.queue, paid_flash: display.paid_flash };
}

module.exports = {
  failPendingPaystackOrder,
  expireStalePendingOrders,
  syncPendingPaystackOrders,
  PENDING_ORDER_TTL_MS: 30 * 60 * 1000,
};
