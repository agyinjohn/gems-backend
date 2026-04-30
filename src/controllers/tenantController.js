const bcrypt = require('bcryptjs');
const { Tenant, Branch, User } = require('../models');

// POST /api/tenants/register — public, creates tenant + business owner account
const registerTenant = async (req, res) => {
  const { business_name, email, password, phone, address } = req.body;
  if (!business_name || !email || !password || !phone || !address) return res.status(400).json({ success: false, message: 'business_name, email, password, phone and address are required.' });

  const existing = await Tenant.findOne({ email: email.toLowerCase().trim() });
  if (existing) return res.status(400).json({ success: false, message: 'A business with this email already exists.' });

  // Generate unique slug from business name
  let slug = business_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const slugExists = await Tenant.findOne({ slug });
  if (slugExists) slug = `${slug}-${Date.now().toString().slice(-4)}`;

  const tenant = await Tenant.create({
    business_name, slug,
    email: email.toLowerCase().trim(),
    phone, address,
    subscription_status: 'trial',
    trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    subscription_expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });

  // Create default branch (HQ)
  const branch = await Branch.create({
    tenant_id: tenant._id,
    name: 'Main Branch',
    slug: 'main',
    address,
    email: email.toLowerCase().trim(),
  });

  // Create business owner account
  const password_hash = await bcrypt.hash(password, 10);
  const owner = await User.create({
    tenant_id: tenant._id,
    branch_id: null, // company-wide
    name: business_name,
    email: email.toLowerCase().trim(),
    password_hash,
    role: 'business_owner',
  });

  // Set branch manager to owner
  branch.manager_id = owner._id;
  await branch.save();

  res.status(201).json({
    success: true,
    message: 'Business registered successfully. You can now log in.',
    data: { tenant: { id: tenant._id, business_name: tenant.business_name, slug: tenant.slug, plan: tenant.plan, subscription_status: tenant.subscription_status, subscription_expires_at: tenant.subscription_expires_at } },
  });
};

// GET /api/platform/tenants — platform admin only
const getAllTenants = async (req, res) => {
  const tenants = await Tenant.find().sort({ createdAt: -1 });
  const data = await Promise.all(tenants.map(async t => {
    const userCount   = await User.countDocuments({ tenant_id: t._id });
    const branchCount = await Branch.countDocuments({ tenant_id: t._id });
    return { ...t.toJSON(), user_count: userCount, branch_count: branchCount };
  }));
  res.json({ success: true, data });
};

// GET /api/platform/tenants/:id
const getTenant = async (req, res) => {
  const tenant = await Tenant.findById(req.params.id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  const branches = await Branch.find({ tenant_id: tenant._id });
  const users    = await User.find({ tenant_id: tenant._id }, '-password_hash');
  res.json({ success: true, data: { ...tenant.toJSON(), branches, users } });
};

// PATCH /api/platform/tenants/:id — platform admin updates plan/status
const updateTenant = async (req, res) => {
  const { plan, subscription_status, subscription_expires_at, max_branches, max_users, is_active } = req.body;
  const update = {};
  if (plan !== undefined) update.plan = plan;
  if (subscription_status !== undefined) update.subscription_status = subscription_status;
  if (subscription_expires_at !== undefined) update.subscription_expires_at = subscription_expires_at;
  if (max_branches !== undefined) update.max_branches = max_branches;
  if (max_users !== undefined) update.max_users = max_users;
  if (is_active !== undefined) update.is_active = is_active;
  const tenant = await Tenant.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  res.json({ success: true, data: tenant });
};

// PATCH /api/platform/tenants/:id/suspend
const suspendTenant = async (req, res) => {
  const tenant = await Tenant.findByIdAndUpdate(req.params.id, { subscription_status: 'suspended', is_active: false }, { new: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  res.json({ success: true, message: 'Tenant suspended.', data: tenant });
};

// PATCH /api/platform/tenants/:id/activate
const activateTenant = async (req, res) => {
  const { expires_at } = req.body;
  const tenant = await Tenant.findByIdAndUpdate(req.params.id, {
    subscription_status: 'active',
    is_active: true,
    subscription_expires_at: expires_at || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  }, { new: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  res.json({ success: true, message: 'Tenant activated.', data: tenant });
};

// GET /api/my-tenant — business owner sees their own tenant info
const getMyTenant = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  const branches = await Branch.find({ tenant_id: tenant._id, is_active: true });
  const userCount = await User.countDocuments({ tenant_id: tenant._id, is_active: true });
  res.json({ success: true, data: { ...tenant.toJSON(), branches, user_count: userCount } });
};

module.exports = { registerTenant, getAllTenants, getTenant, updateTenant, suspendTenant, activateTenant, getMyTenant };
