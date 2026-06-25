const { Product, StockMovement, Order, PosShift } = require('../models');
const logPayment = require('../utils/paymentLog');
const accounting = require('./accountingService');
const { sendOrderConfirmation } = require('./notificationService');
const { verifyPaystackTransaction } = require('./paymentService');

async function getOpenShift(tenantId, userId) {
  return PosShift.findOne({ tenant_id: tenantId, opened_by: userId, status: 'open' }).sort({ opened_at: -1 });
}

async function recordShiftSale(shiftId, { amount, payment_method }) {
  if (!shiftId) return;
  const inc = { sales_count: 1, sales_total: amount };
  const method = payment_method === 'paystack' ? 'momo' : payment_method;
  if (method === 'cash') inc.expected_cash = amount;
  else if (method === 'card') inc.card_total = amount;
  else if (method === 'momo') inc.momo_total = amount;
  await PosShift.findByIdAndUpdate(shiftId, { $inc: inc });
}

async function recordShiftRefund(shiftId, amount, paymentMethod) {
  if (!shiftId) return;
  const inc = { refunds_total: amount };
  if (paymentMethod === 'cash') inc.expected_cash = -amount;
  await PosShift.findByIdAndUpdate(shiftId, { $inc: inc });
}

async function completePosSale({
  tenantId,
  userId,
  branchId,
  items,
  payment_method,
  payment_ref,
  customer_name,
  customer_phone,
  shift_id,
  amount_tendered,
}) {
  let subtotal = 0;
  let cogsTotal = 0;
  const enrichedItems = [];

  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, tenant_id: tenantId, is_active: true });
    if (!p) throw Object.assign(new Error(`Product not found.`), { status: 400 });
    if (p.stock_qty < item.quantity) throw Object.assign(new Error(`Insufficient stock for ${p.name}.`), { status: 400 });
    const total = p.price * item.quantity;
    subtotal += total;
    cogsTotal += (p.cost_price || 0) * item.quantity;
    enrichedItems.push({ product_id: p._id, product_name: p.name, quantity: item.quantity, unit_price: p.price, total });
  }

  const orderNumber = `POS-${Date.now()}-${Math.floor(Math.random() * 100)}`;
  const order = await Order.create({
    tenant_id: tenantId,
    branch_id: branchId || null,
    shift_id: shift_id || null,
    order_number: orderNumber,
    customer_name: customer_name || 'Walk-in Customer',
    customer_phone: customer_phone || '',
    subtotal,
    total: subtotal,
    payment_status: 'paid',
    payment_method: payment_method || 'cash',
    payment_ref: payment_ref || null,
    status: 'delivered',
    source: 'pos',
    items: enrichedItems,
    created_by: userId,
  });

  for (const item of enrichedItems) {
    await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: -item.quantity } });
    await StockMovement.create({
      tenant_id: tenantId,
      product_id: item.product_id,
      type: 'sale',
      quantity: -item.quantity,
      reference: orderNumber,
      created_by: userId,
    });
  }

  await logPayment({
    tenant_id: tenantId,
    source: 'pos',
    reference: orderNumber,
    amount: subtotal,
    method: payment_method || 'cash',
    status: 'success',
    payer_name: customer_name || 'Walk-in Customer',
    description: `POS sale ${orderNumber}`,
    source_id: order._id,
    recorded_by: userId,
  });

  await accounting.postSaleEntry({
    tenantId,
    amount: subtotal,
    cogsAmount: cogsTotal,
    reference: orderNumber,
    date: new Date(),
    sourceId: order._id,
    createdBy: userId,
  }).catch((err) => console.error('[POS] GL posting failed:', err.message));

  await sendOrderConfirmation({
    tenantId,
    order,
    customerEmail: null,
    customerPhone: customer_phone,
    channel: 'pos',
  }).catch(() => {});

  await recordShiftSale(shift_id, { amount: subtotal, payment_method });

  const tendered = parseFloat(amount_tendered) || subtotal;
  return {
    order,
    change: payment_method === 'cash' ? tendered - subtotal : 0,
    amount_tendered: tendered,
  };
}

/**
 * Verify Paystack payment and complete a pending POS sale.
 * Idempotent — safe for client verify + webhook retry.
 */
async function fulfillPosPaystackOrder({ tenantId, orderId, reference, userId, branchId, amount_tendered }) {
  await verifyPaystackTransaction(reference);

  let pending = null;
  if (orderId) {
    const q = { _id: orderId, source: 'pos', payment_status: 'pending' };
    if (tenantId) q.tenant_id = tenantId;
    pending = await Order.findOne(q);
  }
  if (!pending) {
    const q = { payment_ref: reference, source: 'pos', payment_status: 'pending' };
    if (tenantId) q.tenant_id = tenantId;
    pending = await Order.findOne(q);
  }

  if (!pending) {
    const paidQ = { payment_ref: reference, source: 'pos', payment_status: 'paid' };
    if (tenantId) paidQ.tenant_id = tenantId;
    const paid = await Order.findOne(paidQ);
    if (paid) {
      return { order: paid, change: 0, amount_tendered: paid.total, already_fulfilled: true };
    }
    const err = new Error('Pending POS order not found.');
    err.status = 404;
    throw err;
  }

  await Order.findByIdAndDelete(pending._id);

  const result = await completePosSale({
    tenantId: pending.tenant_id,
    userId: userId || pending.created_by,
    branchId: branchId ?? pending.branch_id,
    items: pending.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
    payment_method: pending.payment_method || 'paystack',
    payment_ref: reference,
    customer_name: pending.customer_name,
    customer_phone: pending.customer_phone,
    shift_id: pending.shift_id,
    amount_tendered,
  });

  return { ...result, already_fulfilled: false };
}

module.exports = {
  getOpenShift,
  completePosSale,
  recordShiftRefund,
  fulfillPosPaystackOrder,
};
