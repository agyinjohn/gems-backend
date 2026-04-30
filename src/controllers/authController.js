const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User, Tenant, Branch } = require('../models');
const audit = require('../utils/audit');

const generateToken = (user) =>
  jwt.sign(
    { id: user._id, email: user.email, role: user.role, tenant_id: user.tenant_id, branch_id: user.branch_id, tv: user.token_version || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

const login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });
  const user = await User.findOne({ email: email.toLowerCase().trim(), is_active: true });
  if (!user) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid email or password.' });

  // Attach tenant info if applicable
  let tenantData = null;
  let branchData = null;
  if (user.tenant_id) {
    const tenant = await Tenant.findById(user.tenant_id);
    if (!tenant || !tenant.is_active) return res.status(403).json({ success: false, message: 'Your business account is inactive.' });
    tenantData = { id: tenant._id, business_name: tenant.business_name, slug: tenant.slug, plan: tenant.plan, subscription_status: tenant.subscription_status, subscription_expires_at: tenant.subscription_expires_at };
  }
  if (user.branch_id) {
    const branch = await Branch.findById(user.branch_id);
    if (branch) branchData = { id: branch._id, name: branch.name, slug: branch.slug };
  }

  const token = generateToken(user);
  const { password_hash, ...userObj } = user.toObject();
  // Audit login
  req.user = user; req.tenant_id = user.tenant_id;
  await audit(req, 'LOGIN', 'auth', `${user.name} logged in`, { role: user.role });
  res.json({ success: true, message: 'Login successful', data: { token, user: { ...userObj, id: user._id }, tenant: tenantData, branch: branchData } });
};

const getMe = async (req, res) => {
  let tenantData = null;
  let branchData = null;
  if (req.user.tenant_id) {
    const tenant = await Tenant.findById(req.user.tenant_id);
    if (tenant) tenantData = { id: tenant._id, business_name: tenant.business_name, slug: tenant.slug, plan: tenant.plan, subscription_status: tenant.subscription_status, subscription_expires_at: tenant.subscription_expires_at };
  }
  if (req.user.branch_id) {
    const branch = await Branch.findById(req.user.branch_id);
    if (branch) branchData = { id: branch._id, name: branch.name, slug: branch.slug };
  }
  res.json({ success: true, data: { user: req.user, tenant: tenantData, branch: branchData } });
};

const changePassword = async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ success: false, message: 'Both passwords are required.' });
  if (new_password.length < 8) return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
  if (!/[A-Z]/.test(new_password)) return res.status(400).json({ success: false, message: 'Password must contain at least one uppercase letter.' });
  if (!/[0-9]/.test(new_password)) return res.status(400).json({ success: false, message: 'Password must contain at least one number.' });
  if (!/[^A-Za-z0-9]/.test(new_password)) return res.status(400).json({ success: false, message: 'Password must contain at least one special character.' });
  const user = await User.findById(req.user._id);
  const isMatch = await bcrypt.compare(current_password, user.password_hash);
  if (!isMatch) return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
  user.password_hash = await bcrypt.hash(new_password, 10);
  user.token_version = (user.token_version || 0) + 1;
  await user.save();
  await audit(req, 'CHANGE_PASSWORD', 'auth', `${req.user.name} changed their password`);
  res.json({ success: true, message: 'Password changed successfully.' });
};

const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
  const user = await User.findOne({ email: email.toLowerCase().trim(), is_active: true });
  if (!user) return res.json({ success: true, message: 'If that email exists, a reset code has been sent.' });
  const verificationId   = require('crypto').randomUUID();
  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  user.verification_id      = verificationId;
  user.verification_code    = verificationCode;
  user.verification_expires = new Date(Date.now() + 15 * 60 * 1000);
  await user.save();
  console.log(`[DEV] Reset code for ${email}: ${verificationCode} | ID: ${verificationId}`);
  res.json({ success: true, message: 'If that email exists, a reset code has been sent.', data: { verificationId } });
};

const resetPassword = async (req, res) => {
  const { newPassword, verificationId, verificationCode } = req.body;
  if (!newPassword || !verificationId || !verificationCode) return res.status(400).json({ success: false, message: 'newPassword, verificationId and verificationCode are required.' });
  if (newPassword.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  if (!/[A-Z]/.test(newPassword)) return res.status(400).json({ success: false, message: 'Password must contain at least one uppercase letter.' });
  if (!/[0-9]/.test(newPassword)) return res.status(400).json({ success: false, message: 'Password must contain at least one number.' });
  if (!/[^A-Za-z0-9]/.test(newPassword)) return res.status(400).json({ success: false, message: 'Password must contain at least one special character.' });
  const user = await User.findOne({ verification_id: verificationId, verification_code: verificationCode });
  if (!user) return res.status(400).json({ success: false, message: 'Invalid verification details.' });
  if (user.verification_expires < new Date()) return res.status(400).json({ success: false, message: 'Verification code has expired.' });
  user.password_hash        = await bcrypt.hash(newPassword, 10);
  user.token_version        = (user.token_version || 0) + 1;
  user.verification_id      = null;
  user.verification_code    = null;
  user.verification_expires = null;
  await user.save();
  res.json({ success: true, message: 'Password reset successfully.' });
};

module.exports = { login, getMe, changePassword, forgotPassword, resetPassword };
