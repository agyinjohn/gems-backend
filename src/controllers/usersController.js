const bcrypt = require('bcryptjs');
const { User } = require('../models');

const getUsers = async (req, res) => {
  const users = await User.find({}, '-password_hash').sort({ createdAt: -1 });
  res.json({ success: true, data: users });
};

const getUser = async (req, res) => {
  const user = await User.findById(req.params.id, '-password_hash');
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({ success: true, data: user });
};

const createUser = async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ success: false, message: 'name, email, password, and role are required.' });
  const validRoles = ['super_admin','sales_staff','warehouse_staff','accountant','hr_manager','procurement_officer'];
  if (!validRoles.includes(role)) return res.status(400).json({ success: false, message: 'Invalid role.' });
  const hashed = await bcrypt.hash(password, 10);
  const user = await User.create({ name, email: email.toLowerCase().trim(), password_hash: hashed, role });
  const { password_hash, ...userObj } = user.toObject();
  res.status(201).json({ success: true, message: 'User created successfully.', data: userObj });
};

const updateUser = async (req, res) => {
  const { name, email, role, is_active } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (email !== undefined) update.email = email;
  if (role !== undefined) update.role = role;
  if (is_active !== undefined) update.is_active = is_active;
  const user = await User.findByIdAndUpdate(req.params.id, update, { new: true, select: '-password_hash' });
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({ success: true, message: 'User updated.', data: user });
};

const deleteUser = async (req, res) => {
  if (req.params.id === req.user._id.toString()) return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
  await User.findByIdAndUpdate(req.params.id, { is_active: false });
  res.json({ success: true, message: 'User deactivated successfully.' });
};

module.exports = { getUsers, getUser, createUser, updateUser, deleteUser };
