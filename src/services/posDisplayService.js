const { Order, PosCustomerDisplay } = require('../models');
const { releaseStockForItems, mapOrderItems } = require('./posReservationService');

const DISPLAY_TTL_MS = 30 * 60 * 1000;

function branchKey(branchId) {
  return branchId ? String(branchId) : 'default';
}

async function publishCustomerDisplay({
  tenantId,
  branchId,
  orderId,
  orderNumber,
  customerName,
  amount,
  authorizationUrl,
  reference,
  paymentMethod,
  publishedBy,
}) {
  const expiresAt = new Date(Date.now() + DISPLAY_TTL_MS);
  const filter = {
    tenant_id: tenantId,
    branch_key: branchKey(branchId),
  };

  return PosCustomerDisplay.findOneAndUpdate(
    filter,
    {
      tenant_id: tenantId,
      branch_id: branchId || null,
      branch_key: branchKey(branchId),
      order_id: orderId,
      order_number: orderNumber,
      customer_name: customerName || 'Customer',
      amount,
      authorization_url: authorizationUrl,
      reference,
      payment_method: paymentMethod,
      published_by: publishedBy || null,
      published_at: new Date(),
      expires_at: expiresAt,
      status: 'active',
    },
    { upsert: true, new: true },
  );
}

async function getCustomerDisplay({ tenantId, branchId }) {
  const doc = await PosCustomerDisplay.findOne({
    tenant_id: tenantId,
    branch_key: branchKey(branchId),
    status: 'active',
  }).lean();

  if (!doc) return null;
  if (doc.expires_at && new Date(doc.expires_at) < new Date()) {
    await PosCustomerDisplay.updateOne({ _id: doc._id }, { status: 'expired' });
    return null;
  }

  const order = await Order.findById(doc.order_id).select('payment_status').lean();
  if (!order || order.payment_status !== 'pending') {
    await PosCustomerDisplay.updateOne({ _id: doc._id }, { status: 'cleared' });
    return null;
  }

  return doc;
}

async function clearCustomerDisplay({ tenantId, branchId }) {
  await PosCustomerDisplay.updateOne(
    { tenant_id: tenantId, branch_key: branchKey(branchId), status: 'active' },
    { status: 'cleared' },
  );
}

async function clearCustomerDisplayByOrderId(orderId) {
  await PosCustomerDisplay.updateMany(
    { order_id: orderId, status: 'active' },
    { status: 'cleared' },
  );
}

async function showOrderOnDisplay({ tenantId, branchId, orderId, userId }) {
  const order = await Order.findOne({
    _id: orderId,
    tenant_id: tenantId,
    source: 'pos',
    payment_status: 'pending',
  });

  if (!order) {
    const err = new Error('Pending payment not found.');
    err.status = 404;
    throw err;
  }
  if (!order.paystack_checkout_url) {
    const err = new Error('This payment has no QR link (Mobile Money uses the Paystack popup).');
    err.status = 400;
    throw err;
  }

  return publishCustomerDisplay({
    tenantId,
    branchId: branchId ?? order.branch_id,
    orderId: order._id,
    orderNumber: order.order_number,
    customerName: order.customer_name,
    amount: order.total,
    authorizationUrl: order.paystack_checkout_url,
    reference: order.payment_ref,
    paymentMethod: order.payment_method,
    publishedBy: userId,
  });
}

async function listPendingPaystackOrders({ tenantId, userId, shiftId }) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const orConditions = [{ created_by: userId, createdAt: { $gte: since } }];
  if (shiftId) orConditions.push({ shift_id: shiftId });

  const orders = await Order.find({
    tenant_id: tenantId,
    source: 'pos',
    payment_status: 'pending',
    payment_method: { $in: ['card', 'card_terminal', 'momo'] },
    $or: orConditions,
  })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();

  return orders.map((o) => ({
    order_id: String(o._id),
    order_number: o.order_number,
    customer_name: o.customer_name,
    customer_phone: o.customer_phone || '',
    total: o.total,
    payment_method: o.payment_method,
    reference: o.payment_ref,
    authorization_url: o.paystack_checkout_url || null,
    created_at: o.createdAt,
    expires_at: o.pending_expires_at || null,
  }));
}

async function getDisplayQueue({ tenantId, branchId }) {
  const filter = {
    tenant_id: tenantId,
    source: 'pos',
    payment_status: 'pending',
    paystack_checkout_url: { $exists: true, $ne: '' },
  };
  if (branchId) {
    filter.$or = [{ branch_id: branchId }, { branch_id: null }];
  }

  const orders = await Order.find(filter)
    .sort({ createdAt: 1 })
    .limit(10)
    .lean();

  const focus = await PosCustomerDisplay.findOne({
    tenant_id: tenantId,
    branch_key: branchKey(branchId),
    status: 'active',
  }).lean();

  const displayDoc = await PosCustomerDisplay.findOne({
    tenant_id: tenantId,
    branch_key: branchKey(branchId),
  }).lean();

  let paid_flash = null;
  if (displayDoc?.paid_flash?.at) {
    const age = Date.now() - new Date(displayDoc.paid_flash.at).getTime();
    if (age < 10_000) {
      paid_flash = {
        order_id: String(displayDoc.paid_flash.order_id || ''),
        order_number: displayDoc.paid_flash.order_number,
        customer_name: displayDoc.paid_flash.customer_name,
        amount: displayDoc.paid_flash.amount,
      };
    } else {
      await PosCustomerDisplay.updateOne(
        { _id: displayDoc._id },
        { $unset: { paid_flash: 1 } },
      );
    }
  }

  const queue = orders.map((o) => ({
    order_id: String(o._id),
    order_number: o.order_number,
    customer_name: o.customer_name,
    amount: o.total,
    authorization_url: o.paystack_checkout_url,
    reference: o.payment_ref,
    is_focused: focus ? String(focus.order_id) === String(o._id) : false,
    expires_at: o.pending_expires_at || null,
  }));

  return { queue, paid_flash };
}

async function setPaidDisplayFlash({ tenantId, branchId, orderId, customerName, amount, orderNumber }) {
  await PosCustomerDisplay.findOneAndUpdate(
    { tenant_id: tenantId, branch_key: branchKey(branchId) },
    {
      $set: {
        paid_flash: {
          order_id: orderId,
          order_number: orderNumber,
          customer_name: customerName,
          amount,
          at: new Date(),
        },
      },
      $setOnInsert: {
        tenant_id: tenantId,
        branch_id: branchId || null,
        branch_key: branchKey(branchId),
        order_id: orderId,
        status: 'cleared',
      },
    },
    { upsert: true },
  );
}

async function cancelPendingPaystackOrder({ tenantId, orderId }) {
  const order = await Order.findOne({
    _id: orderId,
    tenant_id: tenantId,
    source: 'pos',
    payment_status: 'pending',
  });

  if (!order) {
    const err = new Error('Pending payment not found.');
    err.status = 404;
    throw err;
  }

  await releaseStockForItems({ tenantId, items: mapOrderItems(order) });
  await Order.findByIdAndDelete(order._id);
  await clearCustomerDisplayByOrderId(orderId);
  return { order_number: order.order_number };
}

module.exports = {
  publishCustomerDisplay,
  getCustomerDisplay,
  clearCustomerDisplay,
  clearCustomerDisplayByOrderId,
  showOrderOnDisplay,
  listPendingPaystackOrders,
  cancelPendingPaystackOrder,
  getDisplayQueue,
  setPaidDisplayFlash,
};
