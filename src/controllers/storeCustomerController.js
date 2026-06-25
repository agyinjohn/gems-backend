const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Tenant, StoreCustomer, Order } = require('../models');

const customerToken = (customer) =>
  jwt.sign(
    { id: customer._id, tenant_id: customer.tenant_id, type: 'store_customer', email: customer.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' },
  );

const register = async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.tenantSlug, is_active: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Store not found.' });

  const { name, email, password, phone } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: 'name, email and password required.' });
  if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

  const exists = await StoreCustomer.findOne({ tenant_id: tenant._id, email: email.toLowerCase().trim() });
  if (exists) return res.status(400).json({ success: false, message: 'An account with this email already exists.' });

  const password_hash = await bcrypt.hash(password, 10);
  const customer = await StoreCustomer.create({
    tenant_id: tenant._id,
    name: name.trim(),
    email: email.toLowerCase().trim(),
    phone: phone || '',
    password_hash,
  });

  const token = customerToken(customer);
  res.status(201).json({
    success: true,
    data: {
      token,
      customer: { id: customer._id, name: customer.name, email: customer.email, phone: customer.phone },
    },
  });
};

const login = async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.tenantSlug, is_active: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Store not found.' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'email and password required.' });

  const customer = await StoreCustomer.findOne({ tenant_id: tenant._id, email: email.toLowerCase().trim() });
  if (!customer) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

  const ok = await bcrypt.compare(password, customer.password_hash);
  if (!ok) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

  const token = customerToken(customer);
  res.json({
    success: true,
    data: {
      token,
      customer: { id: customer._id, name: customer.name, email: customer.email, phone: customer.phone },
    },
  });
};

const getMyOrders = async (req, res) => {
  const orders = await Order.find({
    tenant_id: req.storeCustomer.tenant_id,
    customer_email: req.storeCustomer.email,
    source: 'storefront',
  }).sort({ createdAt: -1 }).limit(50);

  res.json({ success: true, data: orders });
};

const getMe = async (req, res) => {
  res.json({
    success: true,
    data: {
      id: req.storeCustomer._id,
      name: req.storeCustomer.name,
      email: req.storeCustomer.email,
      phone: req.storeCustomer.phone,
    },
  });
};

module.exports = { register, login, getMyOrders, getMe };
