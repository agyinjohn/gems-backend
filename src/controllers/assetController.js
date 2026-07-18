const { StorageLocation, Asset, AssetCategory, AssetLog, Product } = require('../models');
const accounting = require('../services/accountingService');
const audit = require('../utils/audit');
const { resolveWriteBranchId } = require('../middleware/branchScope');

// ── STORAGE LOCATIONS ─────────────────────────────────────────────────────────

const getLocations = async (req, res) => {
  const data = await StorageLocation.find({ tenant_id: req.tenant_id, is_active: true })
    .populate('branch_id', 'name')
    .sort('name');
  res.json({ success: true, data });
};

const createLocation = async (req, res) => {
  const { name, code, type, description, branch_id } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'name is required.' });
  const loc = await StorageLocation.create({
    tenant_id: req.tenant_id,
    branch_id: branch_id || null,
    name, code: code?.trim() || undefined, type, description,
  });
  await audit(req, 'CREATE_LOCATION', 'inventory', `${req.user.name} created location "${name}"`);
  res.status(201).json({ success: true, data: loc });
};

const updateLocation = async (req, res) => {
  const { name, code, type, description, branch_id, is_active } = req.body;
  const loc = await StorageLocation.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    { name, code: code?.trim() || undefined, type, description, branch_id: branch_id || null, is_active },
    { new: true }
  );
  if (!loc) return res.status(404).json({ success: false, message: 'Location not found.' });
  res.json({ success: true, data: loc });
};

const deleteLocation = async (req, res) => {
  const inUse = await Product.countDocuments({ tenant_id: req.tenant_id, location_id: req.params.id, is_active: true });
  if (inUse > 0) return res.status(400).json({ success: false, message: `Cannot delete — ${inUse} product(s) are assigned to this location.` });
  await StorageLocation.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { is_active: false });
  res.json({ success: true, message: 'Location deactivated.' });
};

// ── ASSET CATEGORIES ──────────────────────────────────────────────────────────

const getAssetCategories = async (req, res) => {
  const data = await AssetCategory.find({ tenant_id: req.tenant_id }).sort('name');
  res.json({ success: true, data });
};

const createAssetCategory = async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'name is required.' });
  const cat = await AssetCategory.create({ tenant_id: req.tenant_id, name, description });
  res.status(201).json({ success: true, data: cat });
};

const updateAssetCategory = async (req, res) => {
  const { name, description } = req.body;
  const cat = await AssetCategory.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    { name, description }, { new: true }
  );
  if (!cat) return res.status(404).json({ success: false, message: 'Category not found.' });
  res.json({ success: true, data: cat });
};

const deleteAssetCategory = async (req, res) => {
  const inUse = await Asset.countDocuments({ tenant_id: req.tenant_id, category_id: req.params.id });
  if (inUse > 0) return res.status(400).json({ success: false, message: `Cannot delete — ${inUse} asset(s) use this category.` });
  await AssetCategory.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant_id });
  res.json({ success: true, message: 'Category deleted.' });
};

// ── ASSETS ────────────────────────────────────────────────────────────────────

const getAssets = async (req, res) => {
  const { search, category_id, status, condition } = req.query;
  const filter = { tenant_id: req.tenant_id, ...(req.branchFilter || {}) };
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { asset_code: new RegExp(search, 'i') }, { serial_number: new RegExp(search, 'i') }];
  if (category_id) filter.category_id = category_id;
  if (status) filter.status = status;
  if (condition) filter.condition = condition;
  const data = await Asset.find(filter)
    .populate('category_id', 'name')
    .populate('location_id', 'name code type')
    .populate('assigned_to', 'name employee_code')
    .populate('branch_id', 'name')
    .sort({ createdAt: -1 });
  res.json({ success: true, data });
};

const getAsset = async (req, res) => {
  const asset = await Asset.findOne({ _id: req.params.id, tenant_id: req.tenant_id })
    .populate('category_id', 'name')
    .populate('location_id', 'name code type')
    .populate('assigned_to', 'name employee_code')
    .populate('branch_id', 'name');
  if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
  const logs = await AssetLog.find({ asset_id: asset._id })
    .populate('created_by', 'name')
    .populate('to_location', 'name')
    .populate('from_location', 'name')
    .populate('to_employee', 'name')
    .populate('from_employee', 'name')
    .sort({ createdAt: -1 });
  res.json({ success: true, data: { ...asset.toJSON(), logs } });
};

const createAsset = async (req, res) => {
  const { name, category_id, description, purchase_date, purchase_value, condition, status, assigned_to, location_id, serial_number, warranty_expiry, notes, images, branch_id } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'name is required.' });
  const asset_code = `AST-${Date.now().toString().slice(-6)}`;
  const asset = await Asset.create({
    tenant_id: req.tenant_id,
    branch_id: branch_id || await resolveWriteBranchId(req),
    asset_code, name, category_id: category_id || null,
    description, purchase_date: purchase_date || null,
    purchase_value: purchase_value || 0,
    current_value: purchase_value || 0,
    condition: condition || 'good',
    status: status || 'active',
    assigned_to: assigned_to || null,
    location_id: location_id || null,
    serial_number, warranty_expiry: warranty_expiry || null,
    notes, images: images || [],
    created_by: req.user._id,
  });
  await audit(req, 'CREATE_ASSET', 'assets', `${req.user.name} added asset "${name}"`, { asset_code });
  if (parseFloat(purchase_value) > 0) {
    await accounting.postAssetAcquisitionEntry({
      tenantId: req.tenant_id,
      amount: parseFloat(purchase_value),
      reference: asset_code,
      date: purchase_date ? new Date(purchase_date) : new Date(),
      sourceId: asset._id,
      createdBy: req.user._id,
      paidFromCash: true,
    }).catch((err) => console.error('[Assets] GL acquisition failed:', err.message));
  }
  res.status(201).json({ success: true, data: asset });
};

const updateAsset = async (req, res) => {
  const allowed = ['name','category_id','description','purchase_date','purchase_value','current_value','condition','status','assigned_to','location_id','serial_number','warranty_expiry','notes','images','branch_id'];
  const update = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
  const asset = await Asset.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, update, { new: true });
  if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });
  await audit(req, 'UPDATE_ASSET', 'assets', `${req.user.name} updated asset "${asset.name}"`);
  res.json({ success: true, data: asset });
};

// POST /assets/:id/log — add a maintenance/transfer/repair log entry
const addAssetLog = async (req, res) => {
  const { type, notes, cost, to_location, from_location, to_employee, from_employee } = req.body;
  if (!type || !notes) return res.status(400).json({ success: false, message: 'type and notes are required.' });
  const asset = await Asset.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!asset) return res.status(404).json({ success: false, message: 'Asset not found.' });

  const log = await AssetLog.create({
    tenant_id: req.tenant_id,
    asset_id: asset._id,
    type, notes, cost: cost || 0,
    to_location: to_location || null,
    from_location: from_location || null,
    to_employee: to_employee || null,
    from_employee: from_employee || null,
    created_by: req.user._id,
  });

  // Apply side effects
  if (type === 'transfer') {
    const upd = {};
    if (to_location) upd.location_id = to_location;
    if (to_employee) upd.assigned_to = to_employee;
    await Asset.findByIdAndUpdate(asset._id, upd);
  }
  if (type === 'disposal') {
    await Asset.findByIdAndUpdate(asset._id, { status: 'disposed', condition: 'disposed' });
  }
  if (type === 'condition_change' && req.body.new_condition) {
    await Asset.findByIdAndUpdate(asset._id, { condition: req.body.new_condition });
  }

  res.status(201).json({ success: true, data: log });
};

module.exports = {
  getLocations, createLocation, updateLocation, deleteLocation,
  getAssetCategories, createAssetCategory, updateAssetCategory, deleteAssetCategory,
  getAssets, getAsset, createAsset, updateAsset, addAssetLog,
};
