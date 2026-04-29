const { Category, Product, StockMovement } = require('../models');

const getCategories = async (req, res) => {
  const data = await Category.find().sort('name');
  res.json({ success: true, data });
};

const createCategory = async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Category name is required.' });
  const cat = await Category.create({ name, description });
  res.status(201).json({ success: true, data: cat });
};

const getProducts = async (req, res) => {
  const { search, category_id, is_active, low_stock } = req.query;
  const filter = {};
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { sku: new RegExp(search, 'i') }];
  if (category_id) filter.category_id = category_id;
  if (is_active !== undefined) filter.is_active = is_active === 'true';
  const products = await Product.find(filter).populate('category_id', 'name').sort({ createdAt: -1 });
  let data = products.map(p => ({ ...p.toObject(), id: p._id, category_name: p.category_id?.name }));
  if (low_stock === 'true') data = data.filter(p => p.stock_qty <= p.low_stock_threshold);
  res.json({ success: true, data });
};

const getProduct = async (req, res) => {
  const p = await Product.findById(req.params.id).populate('category_id', 'name');
  if (!p) return res.status(404).json({ success: false, message: 'Product not found.' });
  res.json({ success: true, data: { ...p.toObject(), id: p._id, category_name: p.category_id?.name } });
};

const createProduct = async (req, res) => {
  const { name, sku, barcode, description, category_id, price, cost_price, stock_qty, low_stock_threshold, unit, images } = req.body;
  if (!name || price === undefined) return res.status(400).json({ success: false, message: 'name and price are required.' });
  const finalSku = sku?.trim() || `SKU-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 100)}`;
  const product = await Product.create({ name, sku: finalSku, barcode: barcode?.trim() || null, description, category_id: category_id || null, price, cost_price: cost_price || 0, stock_qty: stock_qty || 0, low_stock_threshold: low_stock_threshold || 10, unit: unit || 'piece', images: images || [], created_by: req.user._id });
  if (stock_qty > 0) await StockMovement.create({ product_id: product._id, type: 'adjustment', quantity: stock_qty, notes: 'Initial stock', created_by: req.user._id });
  res.status(201).json({ success: true, message: 'Product created.', data: product });
};

const updateProduct = async (req, res) => {
  const { name, barcode, description, category_id, price, cost_price, stock_qty, low_stock_threshold, unit, is_active, images } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (barcode !== undefined) update.barcode = barcode?.trim() || null;
  if (description !== undefined) update.description = description;
  if (category_id !== undefined) update.category_id = category_id;
  if (price !== undefined) update.price = price;
  if (cost_price !== undefined) update.cost_price = cost_price;
  if (stock_qty !== undefined) update.stock_qty = stock_qty;
  if (low_stock_threshold !== undefined) update.low_stock_threshold = low_stock_threshold;
  if (unit !== undefined) update.unit = unit;
  if (is_active !== undefined) update.is_active = is_active;
  if (images !== undefined) update.images = images;
  const product = await Product.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
  res.json({ success: true, message: 'Product updated.', data: product });
};

const deleteProduct = async (req, res) => {
  await Product.findByIdAndUpdate(req.params.id, { is_active: false });
  res.json({ success: true, message: 'Product deactivated.' });
};

const adjustStock = async (req, res) => {
  const { quantity, notes } = req.body;
  if (quantity === undefined) return res.status(400).json({ success: false, message: 'quantity is required.' });
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
  const newQty = product.stock_qty + Number(quantity);
  if (newQty < 0) return res.status(400).json({ success: false, message: 'Insufficient stock.' });
  product.stock_qty = newQty;
  await product.save();
  await StockMovement.create({ product_id: product._id, type: 'adjustment', quantity, notes: notes || 'Manual adjustment', created_by: req.user._id });
  res.json({ success: true, message: 'Stock adjusted.', data: { stock_qty: product.stock_qty } });
};

const getStockMovements = async (req, res) => {
  const data = await StockMovement.find({ product_id: req.params.id })
    .populate('product_id', 'name')
    .populate('created_by', 'name')
    .sort({ createdAt: -1 });
  res.json({ success: true, data });
};

module.exports = { getCategories, createCategory, getProducts, getProduct, createProduct, updateProduct, deleteProduct, adjustStock, getStockMovements };
