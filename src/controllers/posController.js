const { PosShift, Order, Tenant } = require('../models');
const { verifyPaystackTransaction } = require('../services/paymentService');
const { getOpenShift, completePosSale } = require('../services/posService');

const openShift = async (req, res) => {
  const existing = await getOpenShift(req.tenant_id, req.user._id);
  if (existing) return res.status(400).json({ success: false, message: 'You already have an open shift.', data: existing });

  const shift = await PosShift.create({
    tenant_id: req.tenant_id,
    branch_id: req.user.branch_id || null,
    opened_by: req.user._id,
    shift_number: `SHIFT-${Date.now()}`,
    opening_float: parseFloat(req.body.opening_float) || 0,
    expected_cash: parseFloat(req.body.opening_float) || 0,
    status: 'open',
  });
  res.status(201).json({ success: true, data: shift });
};

const getCurrentShift = async (req, res) => {
  const shift = await getOpenShift(req.tenant_id, req.user._id);
  res.json({ success: true, data: shift });
};

const closeShift = async (req, res) => {
  const shift = await getOpenShift(req.tenant_id, req.user._id);
  if (!shift) return res.status(404).json({ success: false, message: 'No open shift found.' });

  const actual_cash = parseFloat(req.body.actual_cash);
  if (Number.isNaN(actual_cash)) return res.status(400).json({ success: false, message: 'actual_cash required.' });

  const expected = shift.expected_cash ?? shift.opening_float;
  shift.status = 'closed';
  shift.closed_at = new Date();
  shift.closed_by = req.user._id;
  shift.actual_cash = actual_cash;
  shift.cash_variance = actual_cash - expected;
  shift.notes = req.body.notes || '';
  await shift.save();

  res.json({
    success: true,
    message: 'Shift closed.',
    data: {
      ...shift.toJSON(),
      z_report: buildZReport(shift),
    },
  });
};

const getZReport = async (req, res) => {
  const shift = await PosShift.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!shift) return res.status(404).json({ success: false, message: 'Shift not found.' });
  res.json({ success: true, data: buildZReport(shift) });
};

function buildZReport(shift) {
  const expectedCash = shift.expected_cash ?? shift.opening_float;
  const cashSales = Math.max(0, expectedCash - (shift.opening_float || 0));
  return {
    shift_number: shift.shift_number,
    opened_at: shift.opened_at,
    closed_at: shift.closed_at,
    opening_float: shift.opening_float,
    sales_count: shift.sales_count,
    sales_total: shift.sales_total,
    refunds_total: shift.refunds_total,
    cash_sales: cashSales,
    card_total: shift.card_total || 0,
    momo_total: shift.momo_total || 0,
    expected_cash: expectedCash,
    actual_cash: shift.actual_cash,
    cash_variance: shift.cash_variance,
    status: shift.status,
  };
}

const initPaystackPayment = async (req, res) => {
  const { items, customer_name, customer_phone, payment_method } = req.body;
  if (!items?.length) return res.status(400).json({ success: false, message: 'items required.' });

  const shift = await getOpenShift(req.tenant_id, req.user._id);
  const tenant = await Tenant.findById(req.tenant_id);

  let subtotal = 0;
  const enrichedItems = [];
  for (const item of items) {
    const { Product } = require('../models');
    const p = await Product.findOne({ _id: item.product_id, tenant_id: req.tenant_id, is_active: true });
    if (!p) return res.status(400).json({ success: false, message: 'Product not found.' });
    if (p.stock_qty < item.quantity) return res.status(400).json({ success: false, message: `Insufficient stock for ${p.name}.` });
    const total = p.price * item.quantity;
    subtotal += total;
    enrichedItems.push({ product_id: p._id, product_name: p.name, quantity: item.quantity, unit_price: p.price, total });
  }

  const reference = `POS-PAY-${Date.now()}`;
  const orderNumber = `POS-${Date.now()}-${Math.floor(Math.random() * 100)}`;
  const order = await Order.create({
    tenant_id: req.tenant_id,
    branch_id: req.user.branch_id || null,
    shift_id: shift?._id || null,
    order_number: orderNumber,
    customer_name: customer_name || 'Walk-in Customer',
    customer_phone: customer_phone || '',
    subtotal,
    total: subtotal,
    payment_status: 'pending',
    payment_method: payment_method === 'card' ? 'card' : 'momo',
    payment_ref: reference,
    status: 'pending',
    source: 'pos',
    items: enrichedItems,
    created_by: req.user._id,
  });

  res.json({
    success: true,
    data: {
      order_id: order._id,
      order_number: orderNumber,
      reference,
      amount: subtotal,
      email: tenant?.email || req.user.email,
      paystack_public_key: process.env.PAYSTACK_PUBLIC_KEY,
    },
  });
};

const verifyPaystackPayment = async (req, res) => {
  const { reference, order_id, amount_tendered } = req.body;
  if (!reference || !order_id) return res.status(400).json({ success: false, message: 'reference and order_id required.' });

  const pending = await Order.findOne({ _id: order_id, tenant_id: req.tenant_id, source: 'pos', payment_status: 'pending' });
  if (!pending) return res.status(404).json({ success: false, message: 'Pending POS order not found.' });

  await verifyPaystackTransaction(reference);

  await Order.findByIdAndDelete(pending._id);

  const result = await completePosSale({
    tenantId: req.tenant_id,
    userId: req.user._id,
    branchId: req.user.branch_id,
    items: pending.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
    payment_method: pending.payment_method || 'paystack',
    payment_ref: reference,
    customer_name: pending.customer_name,
    customer_phone: pending.customer_phone,
    shift_id: pending.shift_id,
    amount_tendered,
  });

  res.json({ success: true, data: { ...result.order.toJSON(), change: result.change, amount_tendered: result.amount_tendered } });
};

module.exports = {
  openShift,
  getCurrentShift,
  closeShift,
  getZReport,
  initPaystackPayment,
  verifyPaystackPayment,
};
