const { Branch, User, Tenant } = require('../models');

// GET /api/branches
const getBranches = async (req, res) => {
  const branches = await Branch.find({ tenant_id: req.tenant_id }).populate('manager_id', 'name email').sort('name');
  res.json({ success: true, data: branches });
};

// POST /api/branches
const createBranch = async (req, res) => {
  const { name, address, phone, email, manager_id } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Branch name is required.' });

  // Check plan limits
  const tenant = req.tenant;
  const existing = await Branch.countDocuments({ tenant_id: req.tenant_id, is_active: true });
  if (existing >= tenant.max_branches) return res.status(403).json({ success: false, message: `Your plan allows a maximum of ${tenant.max_branches} branch(es). Please upgrade to add more.` });

  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const slugExists = await Branch.findOne({ tenant_id: req.tenant_id, slug });
  if (slugExists) slug = `${slug}-${Date.now().toString().slice(-4)}`;

  const branch = await Branch.create({ tenant_id: req.tenant_id, name, slug, address, phone, email, manager_id: manager_id || null });
  res.status(201).json({ success: true, data: branch });
};

// PUT /api/branches/:id
const updateBranch = async (req, res) => {
  const { name, address, phone, email, manager_id, is_active } = req.body;
  const branch = await Branch.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    { name, address, phone, email, manager_id: manager_id || null, is_active },
    { new: true }
  );
  if (!branch) return res.status(404).json({ success: false, message: 'Branch not found.' });
  res.json({ success: true, data: branch });
};

// DELETE /api/branches/:id
const deleteBranch = async (req, res) => {
  const branch = await Branch.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    { is_active: false },
    { new: true }
  );
  if (!branch) return res.status(404).json({ success: false, message: 'Branch not found.' });
  res.json({ success: true, message: 'Branch deactivated.' });
};

// GET /api/branches/:id/staff
const getBranchStaff = async (req, res) => {
  const staff = await User.find({ tenant_id: req.tenant_id, branch_id: req.params.id, is_active: true }, '-password_hash');
  res.json({ success: true, data: staff });
};

module.exports = { getBranches, createBranch, updateBranch, deleteBranch, getBranchStaff };
