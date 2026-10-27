const bcrypt = require('bcryptjs');
const { User, Tenant, Employee, Department, Role } = require('../models');
const audit = require('../utils/audit');
const { passwordProblem } = require('../utils/passwordPolicy');

const TENANT_ROLES = ['business_owner', 'branch_manager', 'sales_staff', 'warehouse_staff', 'accountant', 'hr_manager', 'procurement_officer', 'employee', 'custom'];

const getUsers = async (req, res) => {
  const users = await User.find({ tenant_id: req.tenant_id }, '-password_hash')
    .populate('custom_role_id', 'name permissions is_active')
    .sort({ createdAt: -1 });
  res.json({ success: true, data: users });
};

const getUser = async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, tenant_id: req.tenant_id }, '-password_hash');
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({ success: true, data: user });
};

// Employees already on the books who have no login yet — the pick-list for
// "create an account for an existing employee".
const listUnlinkedEmployees = async (req, res) => {
  const data = await Employee.find(
    { tenant_id: req.tenant_id, status: { $ne: 'terminated' }, $or: [{ user_id: null }, { user_id: { $exists: false } }] },
    'name email phone job_title employee_code branch_id department_id',
  ).populate('department_id', 'name').sort('name');
  res.json({ success: true, data });
};

const createUser = async (req, res) => {
  const { employee_id, password, role, custom_role_id, branch_id, gross_salary, job_title, department_id } = req.body;
  let { name, email } = req.body;

  // Creating an account for someone already on the system: take their details
  // from the employee record and link to it instead of making a duplicate.
  let existingEmployee = null;
  if (employee_id) {
    existingEmployee = await Employee.findOne({ _id: employee_id, tenant_id: req.tenant_id });
    if (!existingEmployee) return res.status(404).json({ success: false, message: 'Employee not found.' });
    if (existingEmployee.user_id) return res.status(409).json({ success: false, message: 'This employee already has a user account.' });
    if (existingEmployee.status === 'terminated') return res.status(400).json({ success: false, message: 'Cannot create an account for a terminated employee.' });
    name = name || existingEmployee.name;
    email = email || existingEmployee.email;
  }
  if (!name || !email || !password || !role) return res.status(400).json({ success: false, message: 'name, email, password, and role are required.' });
  if (!TENANT_ROLES.includes(role)) return res.status(400).json({ success: false, message: 'Invalid role.' });
  const pwProblem = passwordProblem(password);
  if (pwProblem) return res.status(400).json({ success: false, message: pwProblem });
  if (role === 'custom' && !custom_role_id) return res.status(400).json({ success: false, message: 'custom_role_id is required for custom roles.' });

  // Validate custom role belongs to this tenant
  if (role === 'custom') {
    const cr = await Role.findOne({ _id: custom_role_id, tenant_id: req.tenant_id, is_active: true });
    if (!cr) return res.status(400).json({ success: false, message: 'Invalid or inactive custom role.' });
  }

  // Logins are unique by email across the whole platform, so look before
  // creating rather than letting the database refuse it.
  const normEmail = email.toLowerCase().trim();
  const taken = await User.findOne({ email: normEmail });
  if (taken) {
    const sameBusiness = String(taken.tenant_id) === String(req.tenant_id);
    if (!sameBusiness) {
      return res.status(409).json({ success: false, message: `${normEmail} is already used by another GEMS account. Use a different email for this user.` });
    }
    // The person already signs in here (often the owner, who is also on the
    // payroll). Connect the employee record to that login instead of making a
    // second account.
    if (existingEmployee) {
      const linkedElsewhere = await Employee.findOne({ tenant_id: req.tenant_id, user_id: taken._id, _id: { $ne: existingEmployee._id } });
      if (linkedElsewhere) {
        return res.status(409).json({ success: false, message: `${taken.name} already has a login and it is linked to the employee record "${linkedElsewhere.name}".` });
      }
      existingEmployee.user_id = taken._id;
      await existingEmployee.save();
      await audit(req, 'LINK_USER', 'users', `${req.user.name} linked employee "${existingEmployee.name}" to the existing login ${normEmail}`, { email: normEmail });
      const { password_hash, ...userObj } = taken.toObject();
      return res.status(200).json({
        success: true,
        linked: true,
        message: `${normEmail} already has a login, so ${existingEmployee.name}'s employee record was linked to it. Their role and password were not changed.`,
        data: userObj,
      });
    }
    return res.status(409).json({ success: false, message: `A user with ${normEmail} already exists in your business.` });
  }

  // Check user limit
  const tenant = req.tenant;
  const count = await User.countDocuments({ tenant_id: req.tenant_id, is_active: true });
  if (count >= tenant.max_users) return res.status(403).json({ success: false, message: `Your plan allows a maximum of ${tenant.max_users} users. Please upgrade.` });

  const hashed = await bcrypt.hash(password, 10);
  const user = await User.create({
    tenant_id: req.tenant_id,
    branch_id: (branch_id || existingEmployee?.branch_id) || null,
    name,
    email: email.toLowerCase().trim(),
    password_hash: hashed,
    role,
    custom_role_id: role === 'custom' ? custom_role_id : null,
  });

  if (existingEmployee) {
    existingEmployee.user_id = user._id;
    if (!existingEmployee.email) existingEmployee.email = user.email;
    await existingEmployee.save();
  } else if (role !== 'business_owner') {
    // Auto-create employee record for staff roles
    const empCode = `EMP-${Date.now().toString().slice(-6)}`;
    await Employee.create({
      tenant_id:     req.tenant_id,
      branch_id:     branch_id || null,
      user_id:       user._id,
      employee_code: empCode,
      name,
      email:         email.toLowerCase().trim(),
      department_id: department_id || null,
      job_title:     job_title || role.replace(/_/g, ' '),
      gross_salary:  parseFloat(gross_salary) || 0,
      start_date:    new Date(),
      status:        'active',
    });
  }

  const { password_hash, ...userObj } = user.toObject();
  await audit(req, 'CREATE_USER', 'users', `${req.user.name} created user "${name}" with role ${role}`, { email, role });
  res.status(201).json({ success: true, message: 'User created successfully.', data: userObj });
};

const updateUser = async (req, res) => {
  const { name, email, role, custom_role_id, branch_id, is_active } = req.body;
  const target = await User.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!target) return res.status(404).json({ success: false, message: 'User not found.' });
  const isSelf = String(target._id) === String(req.user._id);

  const update = {};
  if (name !== undefined) update.name = name;
  if (email !== undefined) update.email = email.toLowerCase().trim();
  if (role !== undefined) {
    if (!TENANT_ROLES.includes(role)) return res.status(400).json({ success: false, message: 'Invalid role.' });
    if (role === 'custom') {
      if (!custom_role_id) return res.status(400).json({ success: false, message: 'Choose which custom role.' });
      const cr = await Role.findOne({ _id: custom_role_id, tenant_id: req.tenant_id, is_active: true });
      if (!cr) return res.status(400).json({ success: false, message: 'Invalid or inactive custom role.' });
    }
    const changing = role !== target.role || (role === 'custom' && String(custom_role_id) !== String(target.custom_role_id || ''));
    if (changing && isSelf) return res.status(400).json({ success: false, message: 'You cannot change your own role.' });
    // Never leave the business without an owner.
    if (changing && target.role === 'business_owner' && role !== 'business_owner') {
      const owners = await User.countDocuments({ tenant_id: req.tenant_id, role: 'business_owner', is_active: true });
      if (owners <= 1) return res.status(400).json({ success: false, message: 'This is the only business owner. Make someone else an owner first.' });
    }
    update.role = role;
    update.custom_role_id = role === 'custom' ? custom_role_id : null;
  }
  if (is_active === false && isSelf) return res.status(400).json({ success: false, message: 'You cannot deactivate your own account.' });
  if (branch_id !== undefined) update.branch_id = branch_id || null;
  if (is_active !== undefined) update.is_active = is_active;
  const user = await User.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, update, { new: true, select: '-password_hash' })
    .populate('custom_role_id', 'name permissions is_active');
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  const roleNote = update.role && update.role !== target.role ? ` (role ${target.role} → ${update.role})` : '';
  await audit(req, 'UPDATE_USER', 'users', `${req.user.name} updated user "${user.name}"${roleNote}`, { user_id: user._id });
  res.json({ success: true, message: 'User updated.', data: user });
};

const deleteUser = async (req, res) => {
  if (req.params.id === req.user._id.toString()) return res.status(400).json({ success: false, message: 'You cannot deactivate your own account.' });
  await User.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { is_active: false });
  res.json({ success: true, message: 'User deactivated successfully.' });
};

module.exports = { listUnlinkedEmployees, getUsers, getUser, createUser, updateUser, deleteUser };
