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

module.exports = { login, getMe, changePassword };
