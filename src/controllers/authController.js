const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require('../models');

const generateToken = (user) =>
  jwt.sign({ id: user._id, email: user.email, role: user.role, tv: user.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

const login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required.' });
  const user = await User.findOne({ email: email.toLowerCase().trim(), is_active: true });
  if (!user) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  const token = generateToken(user);
  const { password_hash, ...userObj } = user.toObject();
  res.json({ success: true, message: 'Login successful', data: { token, user: { ...userObj, id: user._id } } });
};

const getMe = async (req, res) => {
  res.json({ success: true, data: req.user });
};

const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
  const user = await User.findOne({ email: email.toLowerCase().trim(), is_active: true });
  // Always return success to avoid email enumeration
  if (!user) return res.json({ success: true, message: 'If that email exists, a reset code has been sent.' });
  const verificationId   = require('crypto').randomUUID();
  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
  user.verification_id      = verificationId;
  user.verification_code    = verificationCode;
  user.verification_expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  await user.save();
  // TODO: send verificationCode to user.email via email service
  console.log(`[DEV] Reset code for ${email}: ${verificationCode} | ID: ${verificationId}`);
  res.json({ success: true, message: 'If that email exists, a reset code has been sent.', data: { verificationId } });
};

const resetPassword = async (req, res) => {
  const { newPassword, verificationId, verificationCode } = req.body;
  if (!newPassword || !verificationId || !verificationCode)
    return res.status(400).json({ success: false, message: 'newPassword, verificationId and verificationCode are required.' });
  if (newPassword.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  if (!/[A-Z]/.test(newPassword)) return res.status(400).json({ success: false, message: 'Password must contain at least one uppercase letter.' });
  if (!/[0-9]/.test(newPassword)) return res.status(400).json({ success: false, message: 'Password must contain at least one number.' });
  if (!/[^A-Za-z0-9]/.test(newPassword)) return res.status(400).json({ success: false, message: 'Password must contain at least one special character.' });
  const user = await User.findOne({ verification_id: verificationId, verification_code: verificationCode });
  if (!user) return res.status(400).json({ success: false, message: 'Invalid verification details.' });
  if (user.verification_expires < new Date()) return res.status(400).json({ success: false, message: 'Verification code has expired.' });
  user.password_hash        = await bcrypt.hash(newPassword, 10);
  user.token_version        = (user.token_version || 0) + 1;
  user.verification_id      = undefined;
  user.verification_code    = undefined;
  user.verification_expires = undefined;
  await user.save();
  res.json({ success: true, message: 'Password reset successfully.' });
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
  res.json({ success: true, message: 'Password changed successfully.' });
};

module.exports = { login, getMe, changePassword, forgotPassword, resetPassword };
