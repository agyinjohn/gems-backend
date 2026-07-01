const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { Tenant, StoreCustomer, Order } = require('../models');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const customerToken = (customer) =>
  jwt.sign(
    { id: customer._id, tenant_id: customer.tenant_id, type: 'store_customer', email: customer.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' },
  );

const toCustomerData = (c) => ({ id: c._id, name: c.name, email: c.email, phone: c.phone, avatar: c.avatar });

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
    auth_provider: 'local',
  });

  const token = customerToken(customer);
  res.status(201).json({ success: true, data: { token, customer: toCustomerData(customer) } });
};

const login = async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.tenantSlug, is_active: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Store not found.' });

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'email and password required.' });

  const customer = await StoreCustomer.findOne({ tenant_id: tenant._id, email: email.toLowerCase().trim() });
  if (!customer || !customer.password_hash) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

  const ok = await bcrypt.compare(password, customer.password_hash);
  if (!ok) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

  const token = customerToken(customer);
  res.json({ success: true, data: { token, customer: toCustomerData(customer) } });
};

const googleAuth = async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.tenantSlug, is_active: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Store not found.' });

  const { credential } = req.body;
  if (!credential) return res.status(400).json({ success: false, message: 'Google credential required.' });
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(500).json({ success: false, message: 'Google login not configured.' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid Google token.' });
  }

  const { sub: google_id, email, name, picture: avatar } = payload;
  const emailLower = email.toLowerCase().trim();

  // Find by google_id first, then by email (link existing account)
  let customer = await StoreCustomer.findOne({ tenant_id: tenant._id, google_id })
    || await StoreCustomer.findOne({ tenant_id: tenant._id, email: emailLower });

  if (customer) {
    // Update google_id and avatar if not set
    if (!customer.google_id) customer.google_id = google_id;
    if (avatar && !customer.avatar) customer.avatar = avatar;
    await customer.save();
  } else {
    customer = await StoreCustomer.create({
      tenant_id: tenant._id,
      name: name.trim(),
      email: emailLower,
      password_hash: '',
      google_id,
      avatar: avatar || '',
      auth_provider: 'google',
    });
  }

  const token = customerToken(customer);
  res.json({ success: true, data: { token, customer: toCustomerData(customer) } });
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
  res.json({ success: true, data: toCustomerData(req.storeCustomer) });
};

module.exports = { register, login, googleAuth, getMyOrders, getMe };
