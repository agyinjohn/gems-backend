const { Order, Product, StockMovement } = require('../models');
const audit = require('../utils/audit');
const logPayment = require('../utils/paymentLog');
const accounting = require('../services/accountingService');

const generateOrderNumber = () => `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const getOrders = async (req, res) => {
  const { status, payment_status, search } = req.query;
  const filter = { tenant_id: req.tenant_id };
  if (status) filter.status = status;
  if (payment_status) filter.payment_status = payment_status;
  if (search) filter.$or = [{ order_number: new RegExp(search, 'i') }, { customer_name: new RegExp(search, 'i') }];
  const data = await Order.find(filter).populate('created_by', 'name').sort({ createdAt: -1 });
  res.json({ success: true, data });
};

const getOrder = async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  res.json({ success: true, data: order });
};

const createOrder = async (req, res) => {
  const { customer_name, customer_email, customer_phone, delivery_address, items, customer_id, payment_status, payment_method } = req.body;
  if (!customer_name || !items?.length) return res.status(400).json({ success: false, message: 'customer_name and items are required.' });
  let subtotal = 0;
  const enrichedItems = [];
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, tenant_id: req.tenant_id, is_active: true });
    if (!p) throw { status: 400, message: `Product ${item.product_id} not found.` };
    if (p.stock_qty < item.quantity) throw { status: 400, message: `Insufficient stock for ${p.name}.` };
    const total = p.price * item.quantity;
    subtotal += total;
    enrichedItems.push({ product_id: p._id, product_name: p.name, quantity: item.quantity, unit_price: p.price, total });
  }
  const isPaid = payment_status !== 'pending';
  const order = await Order.create({ tenant_id: req.tenant_id, branch_id: req.user.branch_id || null, order_number: generateOrderNumber(), customer_id: customer_id || null, customer_name, customer_email, customer_phone, delivery_address, subtotal, total: subtotal, payment_status: isPaid ? 'paid' : 'pending', payment_method: isPaid ? (payment_method || 'cash') : null, status: isPaid ? 'processing' : 'pending', source: 'internal', items: enrichedItems, created_by: req.user._id });
  if (isPaid) {
    for (const item of enrichedItems) {
      await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: -item.quantity } });
      await StockMovement.create({ tenant_id: req.tenant_id, branch_id: req.user.branch_id || null, product_id: item.product_id, type: 'sale', quantity: -item.quantity, reference: order.order_number, created_by: req.user._id });
    }
    await logPayment({ tenant_id: req.tenant_id, source: 'internal_order', reference: order.order_number, amount: subtotal, method: payment_method || 'cash', status: 'success', payer_name: customer_name, payer_email: customer_email, description: `Internal order ${order.order_number}`, source_id: order._id, recorded_by: req.user._id });
  }
  res.status(201).json({ success: true, message: 'Order created.', data: order });
  await audit(req, 'CREATE_ORDER', 'orders', `${req.user.name} created order ${order.order_number} for ${customer_name}`, { order_number: order.order_number, total: subtotal, items: enrichedItems.length, payment_status: order.payment_status, payment_method: order.payment_method });
};

const updateOrderStatus = async (req, res) => {
  const { status } = req.body;
  const valid = ['pending','processing','shipped','delivered','cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
  const order = await Order.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { status }, { new: true });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  await audit(req, 'UPDATE_ORDER_STATUS', 'orders', `${req.user.name} updated order ${order.order_number} status to "${status}"`, { order_number: order.order_number, status });
  res.json({ success: true, message: 'Order status updated.', data: order });
};

// Storefront — scoped by tenant slug via query param
const getStorefrontProducts = async (req, res) => {
  const { search, category, page = 1, limit = 12, tenant_slug, branch_slug } = req.query;
  const filter = { is_active: true };

  // Resolve tenant from slug
  if (tenant_slug) {
    const { Tenant, Branch } = require('../models');
    const t = await Tenant.findOne({ slug: tenant_slug });
    if (!t) return res.status(404).json({ success: false, message: 'Store not found.' });
    filter.tenant_id = t._id;
    if (branch_slug) {
      const b = await Branch.findOne({ tenant_id: t._id, slug: branch_slug });
      if (b) filter.branch_id = b._id;
    }
  }

  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { description: new RegExp(search, 'i') }];
  if (category) {
    const { Category } = require('../models');
    const cat = await Category.findOne({ name: category, ...(filter.tenant_id ? { tenant_id: filter.tenant_id } : {}) });
    filter.category_id = cat ? cat._id : null;
  }
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [products, total] = await Promise.all([
    Product.find(filter).populate('category_id', 'name').sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    Product.countDocuments(filter),
  ]);
  const data = products.map(p => ({ ...p.toObject(), id: p._id, category: p.category_id?.name, category_name: p.category_id?.name }));
  res.json({ success: true, data, total, page: parseInt(page), hasMore: skip + data.length < total });
};

const initiateCheckout = async (req, res) => {
  const { customer_name, customer_email, customer_phone, delivery_address, delivery_fee, items, tenant_id, branch_id } = req.body;
  if (!customer_name || !customer_email || !items?.length) return res.status(400).json({ success: false, message: 'customer_name, customer_email and items are required.' });

  // Group items by branch
  const branchGroups = {};
  let resolvedTenantId = tenant_id;
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, is_active: true });
    if (!p) throw { status: 400, message: `Product ${item.product_id} not found.` };
    if (p.stock_qty < item.quantity) throw { status: 400, message: `Insufficient stock for ${p.name}.` };
    if (!resolvedTenantId) resolvedTenantId = p.tenant_id;
    const bId = String(item.branch_id || p.branch_id || 'default');
    if (!branchGroups[bId]) branchGroups[bId] = { branch_id: item.branch_id || p.branch_id || null, branch_name: item.branch_name || 'Main Branch', items: [] };
    branchGroups[bId].items.push({ product: p, quantity: item.quantity });
  }

  // Create one order per branch
  const orders = [];
  for (const [, group] of Object.entries(branchGroups)) {
    let subtotal = 0;
    const enrichedItems = [];
    for (const { product: p, quantity } of group.items) {
      const total = p.price * quantity;
      subtotal += total;
      enrichedItems.push({ product_id: p._id, product_name: p.name, quantity, unit_price: p.price, total });
    }
    const fee = Object.keys(branchGroups).length === 1 ? (parseFloat(delivery_fee) || 0) : 0;
    const total = subtotal + fee;
    const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const order = await Order.create({
      tenant_id: resolvedTenantId,
      branch_id: group.branch_id,
      order_number: orderNumber,
      customer_name, customer_email, customer_phone, delivery_address,
      subtotal, total,
      payment_status: 'pending',
      status: 'pending',
      source: 'storefront',
      items: enrichedItems,
    });
    orders.push({ order_id: order._id, order_number: orderNumber, total, branch_name: group.branch_name });
  }

  const grandTotal = orders.reduce((s, o) => s + o.total, 0);
  const paystackRef = `GEMS-${Date.now()}`;
  res.status(201).json({ success: true, data: { orders, grand_total: grandTotal, email: customer_email, paystack_public_key: process.env.PAYSTACK_PUBLIC_KEY, reference: paystackRef } });
};

const verifyPayment = async (req, res) => {
  const { reference, order_ids } = req.body; // order_ids is array
  if (!reference || !order_ids?.length) return res.status(400).json({ success: false, message: 'reference and order_ids required.' });
  const https = require('node:https');
  const options = { hostname: 'api.paystack.co', path: `/transaction/verify/${reference}`, method: 'GET', headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } };
  let body = '';
  const paystackReq = https.request(options, (paystackRes) => {
    paystackRes.on('data', d => body += d);
    paystackRes.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (data.data?.status === 'success') {
          const orderNumbers = [];
          for (const order_id of order_ids) {
            const order = await Order.findOne({ _id: order_id, payment_status: 'pending' });
            if (!order) continue;
            order.payment_status = 'paid';
            order.payment_ref = reference;
            order.payment_method = 'paystack';
            order.status = 'processing';
            await order.save();
            orderNumbers.push(order.order_number);
            await logPayment({ tenant_id: order.tenant_id, source: 'storefront', reference: order.order_number, amount: order.total, method: 'paystack', status: 'success', payer_name: order.customer_name, payer_email: order.customer_email, description: `Storefront order ${order.order_number}`, source_id: order._id });
            await accounting.postSaleEntry({ tenantId: order.tenant_id, amount: order.total, cogsAmount: order.subtotal, taxAmount: order.tax_amount || 0, reference: order.order_number, date: new Date(), sourceId: order._id }).catch(() => {});
            for (const item of order.items) {
              await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: -item.quantity } });
              await StockMovement.create({ tenant_id: order.tenant_id, product_id: item.product_id, type: 'sale', quantity: -item.quantity, reference: order.order_number });
            }
          }
          res.json({ success: true, message: 'Payment verified. Orders confirmed!', data: { order_numbers: orderNumbers } });
        } else {
          for (const order_id of order_ids) await Order.findByIdAndUpdate(order_id, { payment_status: 'failed' });
          res.status(400).json({ success: false, message: 'Payment verification failed.' });
        }
      } catch { res.status(500).json({ success: false, message: 'Payment verification error.' }); }
    });
  });
  paystackReq.on('error', () => res.status(500).json({ success: false, message: 'Could not reach Paystack.' }));
  paystackReq.end();
};

module.exports = { getOrders, getOrder, createOrder, updateOrderStatus, getStorefrontProducts, initiateCheckout, verifyPayment };
