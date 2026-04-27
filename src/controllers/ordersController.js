const { Order, Product, StockMovement } = require('../models');

const generateOrderNumber = () => `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const getOrders = async (req, res) => {
  const { status, payment_status, search } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (payment_status) filter.payment_status = payment_status;
  if (search) filter.$or = [{ order_number: new RegExp(search, 'i') }, { customer_name: new RegExp(search, 'i') }];
  const data = await Order.find(filter).populate('created_by', 'name').sort({ createdAt: -1 });
  res.json({ success: true, data });
};

const getOrder = async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  res.json({ success: true, data: order });
};

const createOrder = async (req, res) => {
  const { customer_name, customer_email, customer_phone, delivery_address, items, customer_id } = req.body;
  if (!customer_name || !items?.length) return res.status(400).json({ success: false, message: 'customer_name and items are required.' });
  let subtotal = 0;
  const enrichedItems = [];
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, is_active: true });
    if (!p) throw { status: 400, message: `Product ${item.product_id} not found.` };
    if (p.stock_qty < item.quantity) throw { status: 400, message: `Insufficient stock for ${p.name}.` };
    const total = p.price * item.quantity;
    subtotal += total;
    enrichedItems.push({ product_id: p._id, product_name: p.name, quantity: item.quantity, unit_price: p.price, total });
  }
  const order = await Order.create({ order_number: generateOrderNumber(), customer_id: customer_id || null, customer_name, customer_email, customer_phone, delivery_address, subtotal, total: subtotal, payment_status: 'paid', status: 'processing', source: 'internal', items: enrichedItems, created_by: req.user._id });
  for (const item of enrichedItems) {
    await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: -item.quantity } });
    await StockMovement.create({ product_id: item.product_id, type: 'sale', quantity: -item.quantity, reference: order.order_number, created_by: req.user._id });
  }
  res.status(201).json({ success: true, message: 'Order created.', data: order });
};

const updateOrderStatus = async (req, res) => {
  const { status } = req.body;
  const valid = ['pending','processing','shipped','delivered','cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
  const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  res.json({ success: true, message: 'Order status updated.', data: order });
};

const getStorefrontProducts = async (req, res) => {
  const { search, category_id, category, page = 1, limit = 12 } = req.query;
  const filter = { is_active: true };
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { description: new RegExp(search, 'i') }];
  if (category_id) filter.category_id = category_id;
  if (category) {
    const { Category } = require('../models');
    const cat = await Category.findOne({ name: category });
    if (cat) filter.category_id = cat._id;
    else filter.category_id = null; // no match → return empty
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
  const { customer_name, customer_email, customer_phone, delivery_address, delivery_fee, items } = req.body;
  if (!customer_name || !customer_email || !items?.length) return res.status(400).json({ success: false, message: 'customer_name, customer_email and items are required.' });
  let subtotal = 0;
  const enrichedItems = [];
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, is_active: true });
    if (!p) throw { status: 400, message: `Product ${item.product_id} not found.` };
    if (p.stock_qty < item.quantity) throw { status: 400, message: `Insufficient stock for ${p.name}.` };
    const total = p.price * item.quantity;
    subtotal += total;
    enrichedItems.push({ product_id: p._id, product_name: p.name, quantity: item.quantity, unit_price: p.price, total });
  }
  const fee = parseFloat(delivery_fee) || 0;
  const total = subtotal + fee;
  const orderNumber = generateOrderNumber();
  const order = await Order.create({ order_number: orderNumber, customer_name, customer_email, customer_phone, delivery_address, subtotal, total, payment_status: 'pending', status: 'pending', source: 'storefront', items: enrichedItems });
  res.status(201).json({ success: true, data: { order_id: order._id, order_number: orderNumber, total, email: customer_email, paystack_public_key: process.env.PAYSTACK_PUBLIC_KEY } });
};

const verifyPayment = async (req, res) => {
  const { reference, order_id } = req.body;
  if (!reference || !order_id) return res.status(400).json({ success: false, message: 'reference and order_id required.' });
  const https = require('node:https');
  const options = { hostname: 'api.paystack.co', path: `/transaction/verify/${reference}`, method: 'GET', headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } };
  let body = '';
  const paystackReq = https.request(options, (paystackRes) => {
    paystackRes.on('data', d => body += d);
    paystackRes.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (data.data?.status === 'success') {
          const order = await Order.findOne({ _id: order_id, payment_status: 'pending' });
          if (!order) return res.status(400).json({ success: false, message: 'Order not found or already processed.' });
          order.payment_status = 'paid';
          order.payment_ref = reference;
          order.payment_method = 'paystack';
          order.status = 'processing';
          await order.save();
          for (const item of order.items) {
            await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: -item.quantity } });
            await StockMovement.create({ product_id: item.product_id, type: 'sale', quantity: -item.quantity, reference: order.order_number });
          }
          res.json({ success: true, message: 'Payment verified. Order confirmed!', data: { order_number: order.order_number } });
        } else {
          await Order.findByIdAndUpdate(order_id, { payment_status: 'failed' });
          res.status(400).json({ success: false, message: 'Payment verification failed.' });
        }
      } catch { res.status(500).json({ success: false, message: 'Payment verification error.' }); }
    });
  });
  paystackReq.on('error', () => res.status(500).json({ success: false, message: 'Could not reach Paystack.' }));
  paystackReq.end();
};

module.exports = { getOrders, getOrder, createOrder, updateOrderStatus, getStorefrontProducts, initiateCheckout, verifyPayment };
