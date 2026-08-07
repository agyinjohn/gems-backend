const { Category, Product, StockMovement } = require('../models');
const audit = require('../utils/audit');
const { resolveWriteBranchId } = require('../middleware/branchScope');

const getCategories = async (req, res) => {
  let tenantId = req.tenant_id;
  if (!tenantId && req.query.tenant_slug) {
    const { Tenant } = require('../models');
    const t = await Tenant.findOne({ slug: req.query.tenant_slug });
    if (!t) return res.status(404).json({ success: false, message: 'Store not found.' });
    tenantId = t._id;
  }
  const filter = { tenant_id: tenantId };
  if (req.query.scope) filter.scope = req.query.scope;
  const data = await Category.find(filter).sort('name');
  res.json({ success: true, data });
};

const createCategory = async (req, res) => {
  const { name, description, scope } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Category name is required.' });
  const cat = await Category.create({ tenant_id: req.tenant_id, name, description, scope: scope || 'product' });
  res.status(201).json({ success: true, data: cat });
};

const updateCategory = async (req, res) => {
  const { name, description, scope } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Category name is required.' });
  const cat = await Category.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    { name, description, ...(scope !== undefined && { scope }) },
    { new: true }
  );
  if (!cat) return res.status(404).json({ success: false, message: 'Category not found.' });
  res.json({ success: true, data: cat });
};

const deleteCategory = async (req, res) => {
  const inUse = await Product.countDocuments({ tenant_id: req.tenant_id, category_id: req.params.id, is_active: true });
  if (inUse > 0) return res.status(400).json({ success: false, message: `Cannot delete — ${inUse} product(s) use this category.` });
  await Category.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant_id });
  res.json({ success: true, message: 'Category deleted.' });
};

function normalizeImages(images) {
  if (images === undefined || images === null) return [];
  const list = Array.isArray(images) ? images : [images];
  return list.map((url) => String(url).trim()).filter(Boolean).slice(0, 8);
}

const getProducts = async (req, res) => {
  const { search, category_id, is_active, low_stock, item_type } = req.query;
  const filter = { tenant_id: req.tenant_id, ...(req.branchFilter || {}) };
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { sku: new RegExp(search, 'i') }];
  if (category_id) filter.category_id = category_id;
  if (is_active !== undefined) filter.is_active = is_active === 'true';
  // Allow filtering by catalog type: ?item_type=product|service|bundle
  if (item_type) filter.item_type = item_type;
  const products = await Product.find(filter)
    .populate('category_id', 'name')
    .populate('bundle_items.product_id', 'name')
    .sort({ createdAt: -1 });
  let data = products.map(p => ({ ...p.toObject(), id: p._id, category_name: p.category_id?.name }));
  // low_stock only makes sense for physical products
  if (low_stock === 'true') data = data.filter(p => p.item_type !== 'service' && p.stock_qty <= p.low_stock_threshold);
  res.json({ success: true, data });
};

const getProduct = async (req, res) => {
  const p = await Product.findOne({ _id: req.params.id, tenant_id: req.tenant_id }).populate('category_id', 'name');
  if (!p) return res.status(404).json({ success: false, message: 'Product not found.' });
  res.json({ success: true, data: { ...p.toObject(), id: p._id, category_name: p.category_id?.name } });
};

function normalizeCategoryId(value) {
  if (value === undefined || value === null || value === '') return null;
  const str = String(value).trim();
  return str || null;
}

const createProduct = async (req, res) => {
  const {
    name, sku, barcode, description, category_id, price, cost_price,
    stock_qty, low_stock_threshold, unit, images, attributes,
    item_type, unit_type, duration, revenue_account_code, bundle_items,
  } = req.body;
  if (!name || price === undefined) return res.status(400).json({ success: false, message: 'name and price are required.' });

  const catalogType = ['product', 'service', 'bundle'].includes(item_type) ? item_type : 'product';
  const isService = catalogType === 'service';
  const isBundle = catalogType === 'bundle';

  // Services don't need a SKU — only generate one for physical products
  const finalSku = isService
    ? (sku?.trim() || null)
    : (sku?.trim() || `SKU-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 100)}`);

  const branchId = await resolveWriteBranchId(req);

  const product = await Product.create({
    tenant_id:    req.tenant_id,
    branch_id:    branchId,
    name,
    sku:          finalSku,
    barcode:      barcode?.trim() || null,
    description,
    category_id:  normalizeCategoryId(category_id),
    item_type:    catalogType,
    unit_type:    unit_type || 'fixed',
    duration:     duration != null ? Number(duration) : null,
    revenue_account_code: revenue_account_code?.trim() || null,
    price,
    cost_price:          cost_price || 0,
    // Services have no physical stock
    stock_qty:           isService ? 0 : (stock_qty || 0),
    low_stock_threshold: isService ? 0 : (low_stock_threshold || 10),
    unit:                unit || (isService ? 'service' : 'piece'),
    images:              normalizeImages(images),
    attributes:          attributes || {},
    bundle_items:        isBundle ? (Array.isArray(bundle_items) ? bundle_items : []) : [],
    created_by:          req.user._id,
  });

  // Only create an opening stock movement for physical products (not bundles)
  if (!isService && !isBundle && stock_qty > 0) {
    await StockMovement.create({
      tenant_id:  req.tenant_id,
      branch_id:  branchId,
      product_id: product._id,
      type:       'adjustment',
      quantity:   stock_qty,
      notes:      'Initial stock',
      created_by: req.user._id,
    });
  }

  await audit(req, 'CREATE_PRODUCT', 'inventory',
    `${req.user.name} added ${catalogType} "${product.name}"`,
    { sku: product.sku, price: product.price, item_type: catalogType },
  );
  res.status(201).json({ success: true, message: `${catalogType.charAt(0).toUpperCase() + catalogType.slice(1)} created.`, data: product });
};

const updateProduct = async (req, res) => {
  const {
    name, barcode, description, category_id, price, cost_price,
    stock_qty, low_stock_threshold, unit, is_active, images,
    unit_type, duration, revenue_account_code,
  } = req.body;

  const existing = await Product.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!existing) return res.status(404).json({ success: false, message: 'Product not found.' });

  const isService = existing.item_type === 'service';
  const isBundle  = existing.item_type === 'bundle';

  const update = {};
  if (name !== undefined)        update.name        = name;
  if (barcode !== undefined)     update.barcode     = barcode?.trim() || null;
  if (description !== undefined) update.description = description;
  if (category_id !== undefined) update.category_id = normalizeCategoryId(category_id);
  if (price !== undefined)       update.price       = price;
  if (cost_price !== undefined)  update.cost_price  = cost_price;
  if (is_active !== undefined)   update.is_active   = is_active;
  if (images !== undefined)      update.images      = normalizeImages(images);
  if (req.body.attributes !== undefined) update.attributes = req.body.attributes;
  if (existing.item_type === 'bundle' && req.body.bundle_items !== undefined)
    update.bundle_items = Array.isArray(req.body.bundle_items) ? req.body.bundle_items : [];
  // Service-specific fields
  if (unit_type !== undefined)           update.unit_type           = unit_type;
  if (duration !== undefined)            update.duration            = duration != null ? Number(duration) : null;
  if (revenue_account_code !== undefined) update.revenue_account_code = revenue_account_code?.trim() || null;
  // Stock fields only apply to physical products (not services or bundles)
  if (!isService && !isBundle) {
    if (stock_qty !== undefined)           update.stock_qty           = stock_qty;
    if (low_stock_threshold !== undefined) update.low_stock_threshold = low_stock_threshold;
    if (unit !== undefined)                update.unit                = unit;
  }

  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    update,
    { new: true },
  );
  await audit(req, 'UPDATE_PRODUCT', 'inventory',
    `${req.user.name} updated ${product.item_type} "${product.name}"`,
    { product_id: product._id, item_type: product.item_type },
  );
  res.json({ success: true, message: 'Updated.', data: product });
};

const deleteProduct = async (req, res) => {
  await Product.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { is_active: false });
  res.json({ success: true, message: 'Product deactivated.' });
};

const adjustStock = async (req, res) => {
  const { quantity, notes } = req.body;
  if (quantity === undefined) return res.status(400).json({ success: false, message: 'quantity is required.' });
  const product = await Product.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
  // Stock adjustments are meaningless for services and bundles
  if (product.item_type === 'service' || product.item_type === 'bundle') {
    return res.status(400).json({ success: false, message: 'Stock adjustments do not apply to services or bundles.' });
  }
  const newQty = product.stock_qty + Number(quantity);
  if (newQty < 0) return res.status(400).json({ success: false, message: 'Insufficient stock.' });
  product.stock_qty = newQty;
  await product.save();
  await StockMovement.create({ tenant_id: req.tenant_id, branch_id: product.branch_id || await resolveWriteBranchId(req), product_id: product._id, type: 'adjustment', quantity, notes: notes || 'Manual adjustment', created_by: req.user._id });
  await audit(req, 'ADJUST_STOCK', 'inventory', `${req.user.name} adjusted stock for "${product.name}" by ${quantity > 0 ? '+' : ''}${quantity}`, { product_id: product._id, quantity, new_qty: newQty });
  res.json({ success: true, message: 'Stock adjusted.', data: { stock_qty: product.stock_qty } });
};

const getStockMovements = async (req, res) => {
  const data = await StockMovement.find({ tenant_id: req.tenant_id, ...(req.branchFilter || {}), product_id: req.params.id })
    .populate('product_id', 'name')
    .populate('created_by', 'name')
    .sort({ createdAt: -1 });
  res.json({ success: true, data });
};

module.exports = { getCategories, createCategory, updateCategory, deleteCategory, getProducts, getProduct, createProduct, updateProduct, deleteProduct, adjustStock, getStockMovements };
