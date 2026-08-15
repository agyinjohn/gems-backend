const { Category, Product, StockMovement } = require('../models');
const serviceTypes = require('../config/serviceTypes');
const audit = require('../utils/audit');
const { resolveWriteBranchId } = require('../middleware/branchScope');
const variants = require('../services/variantService');

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

/**
 * The choices this kind of thing comes in.
 *
 * Cleaned rather than trusted: a blank option name, or a value typed twice with
 * different capitals, would each become a size customers can pick and nobody
 * stocks. Order is kept, because "S, M, L, XL" is not alphabetical and a shop
 * that typed it that way meant it.
 */
function cleanOptions(input) {
  if (!Array.isArray(input)) return undefined;
  const out = [];
  for (const raw of input.slice(0, 5)) {
    const name = String(raw?.name || '').trim().slice(0, 40);
    if (!name || out.some(o => o.name.toLowerCase() === name.toLowerCase())) continue;

    const values = [];
    for (const v of (Array.isArray(raw?.values) ? raw.values : []).slice(0, 50)) {
      const value = String(v || '').trim().slice(0, 40);
      if (value && !values.some(x => x.toLowerCase() === value.toLowerCase())) values.push(value);
    }
    if (values.length) out.push({ name, values });
  }
  return out;
}

const createCategory = async (req, res) => {
  const { name, description, scope, options } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Category name is required.' });
  const cat = await Category.create({
    tenant_id: req.tenant_id, name, description, scope: scope || 'product',
    options: cleanOptions(options) || [],
  });
  res.status(201).json({ success: true, data: cat });
};

const updateCategory = async (req, res) => {
  const { name, description, scope, options, custom_fields } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Category name is required.' });
  const cleanedOptions = cleanOptions(options);
  const cat = await Category.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    {
      name, description,
      ...(scope !== undefined && { scope }),
      ...(cleanedOptions !== undefined && { options: cleanedOptions }),
      ...(custom_fields !== undefined && { custom_fields }),
    },
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

/**
 * Shop-authored copy on its way to a public page.
 *
 * Trimmed, capped and stripped of empties. The caps are not arbitrary: a
 * highlight is a scannable line rather than a paragraph, and a short
 * description that runs long stops being short exactly where it is most
 * needed — inside a product card.
 */
const COPY_LIMITS = { short_description: 200, brand: 60, highlight: 120, highlights: 6 };

const cleanLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const cleanHighlights = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map(h => cleanLine(h, COPY_LIMITS.highlight))
    .filter(Boolean)
    .slice(0, COPY_LIMITS.highlights);
};

const { uniqueSlug } = require('../utils/slug');

const createProduct = async (req, res) => {
  const {
    name, sku, barcode, description, category_id, price, cost_price,
    stock_qty, low_stock_threshold, unit, images, attributes,
    item_type, unit_type, duration, revenue_account_code, bundle_items,
    pricing_mode, min_price, max_price, service_type, requires_file,
    sell_online, requestable, short_description, brand, highlights,
    option_values,
  } = req.body;
  if (!name || price === undefined) return res.status(400).json({ success: false, message: 'name and price are required.' });

  // Open pricing means the amount is quoted when the item is sold, so the
  // catalog price is only a suggestion and the bounds are what constrain it.
  const priceMode = pricing_mode === 'open' ? 'open' : 'fixed';
  const minPrice = Number(min_price) || 0;
  const maxPrice = Number(max_price) || 0;
  if (priceMode === 'open' && minPrice > 0 && maxPrice > 0 && minPrice > maxPrice) {
    return res.status(400).json({ success: false, message: 'Minimum price cannot be above the maximum price.' });
  }

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
    // Its public address, settled once at creation. See the schema for why it
    // is not recomputed when a product is renamed.
    slug:         await uniqueSlug(Product, { tenant_id: req.tenant_id, name, fallback: 'item' }),
    sku:          finalSku,
    barcode:      barcode?.trim() || null,
    description,
    category_id:  normalizeCategoryId(category_id),
    item_type:    catalogType,
    // Only meaningful on a service: what kind of work it is, and whether a
    // client has to send something in before it can be started.
    service_type: isService && serviceTypes.TYPE_KEYS.includes(service_type)
      ? service_type
      : serviceTypes.DEFAULT_TYPE,
    requires_file: isService && !!requires_file,
    // Where it is offered. Absent means the old behaviour: everywhere.
    sell_online:  sell_online === undefined ? true : !!sell_online,
    requestable:  requestable === undefined ? true : !!requestable,
    unit_type:    unit_type || 'fixed',
    duration:     duration != null ? Number(duration) : null,
    revenue_account_code: revenue_account_code?.trim() || null,
    pricing_mode: priceMode,
    min_price:    priceMode === 'open' ? minPrice : 0,
    max_price:    priceMode === 'open' ? maxPrice : 0,
    price,
    cost_price:          cost_price || 0,
    // Services have no physical stock
    stock_qty:           isService ? 0 : (stock_qty || 0),
    low_stock_threshold: isService ? 0 : (low_stock_threshold || 10),
    unit:                unit || (isService ? 'service' : 'piece'),
    images:              normalizeImages(images),
    short_description:   cleanLine(short_description, COPY_LIMITS.short_description),
    brand:               cleanLine(brand, COPY_LIMITS.brand),
    highlights:          cleanHighlights(highlights),
    attributes:          attributes || {},
    // The shop ticks which values it stocks — { Size: ['S','M'], Colour:
    // ['Navy'] } — and the combinations are worked out from that. Typing the
    // cross product by hand is how a shirt ends up with a navy medium and no
    // navy small, silently.
    variants:            isService || isBundle ? [] : variants.buildVariants(option_values),
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
    pricing_mode, min_price, max_price, service_type, requires_file,
    sell_online, requestable, short_description, brand, highlights,
    option_values, variant_stock,
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

  // Options, and the stock behind each combination.
  //
  // Rebuilt from what the shop has ticked, carrying over the count and any
  // price difference already recorded against a combination that survives the
  // edit — adding extra-large to a shirt must not reset the eleven navy
  // mediums somebody counted last week.
  if (option_values !== undefined && !isService && !isBundle) {
    const rebuilt = variants.buildVariants(option_values, existing.variants);
    for (const row of rebuilt) {
      const counted = variant_stock?.[row.key];
      if (counted && typeof counted === 'object') {
        if (counted.stock_qty !== undefined) row.stock_qty = Math.max(0, Number(counted.stock_qty) || 0);
        if (counted.price_delta !== undefined) row.price_delta = Number(counted.price_delta) || 0;
        if (counted.sku !== undefined) row.sku = String(counted.sku || '').trim();
      }
    }
    update.variants = rebuilt;
    // stock_qty for a product sold in options is the sum of its rows, not a
    // figure of its own, so it is derived here rather than accepted.
    if (rebuilt.length) update.stock_qty = variants.totalStock({ variants: rebuilt });
  }
  // Only when asked for by name. Renaming a product must not silently move it
  // to a new address and break links a shop has already sent to customers.
  if (req.body.slug !== undefined) {
    update.slug = await uniqueSlug(Product, {
      tenant_id: req.tenant_id, name: req.body.slug, fallback: 'item', excludeId: existing._id,
    });
  } else if (!existing.slug) {
    // Created before slugs existed. Give it one the first time it is saved,
    // so the backfill is not the only way a product gets an address.
    update.slug = await uniqueSlug(Product, {
      tenant_id: req.tenant_id, name: name || existing.name, fallback: 'item', excludeId: existing._id,
    });
  }
  if (short_description !== undefined) update.short_description = cleanLine(short_description, COPY_LIMITS.short_description);
  if (brand !== undefined)             update.brand             = cleanLine(brand, COPY_LIMITS.brand);
  if (highlights !== undefined)        update.highlights        = cleanHighlights(highlights);
  if (existing.item_type === 'bundle' && req.body.bundle_items !== undefined)
    update.bundle_items = Array.isArray(req.body.bundle_items) ? req.body.bundle_items : [];
  // Service-specific fields
  if (isService && service_type !== undefined && serviceTypes.TYPE_KEYS.includes(service_type)) {
    update.service_type = service_type;
  }
  if (isService && requires_file !== undefined) update.requires_file = !!requires_file;
  if (sell_online !== undefined) update.sell_online = !!sell_online;
  if (requestable !== undefined) update.requestable = !!requestable;
  if (unit_type !== undefined)           update.unit_type           = unit_type;
  if (duration !== undefined)            update.duration            = duration != null ? Number(duration) : null;
  if (revenue_account_code !== undefined) update.revenue_account_code = revenue_account_code?.trim() || null;
  // Pricing mode and its bounds. Validate against the mode that will be in
  // force after this update, not the one stored before it.
  if (pricing_mode !== undefined) update.pricing_mode = pricing_mode === 'open' ? 'open' : 'fixed';
  if (min_price !== undefined) update.min_price = Number(min_price) || 0;
  if (max_price !== undefined) update.max_price = Number(max_price) || 0;
  const effectiveMode = update.pricing_mode ?? existing.pricing_mode ?? 'fixed';
  if (effectiveMode === 'open') {
    const lo = update.min_price ?? existing.min_price ?? 0;
    const hi = update.max_price ?? existing.max_price ?? 0;
    if (lo > 0 && hi > 0 && lo > hi) {
      return res.status(400).json({ success: false, message: 'Minimum price cannot be above the maximum price.' });
    }
  } else {
    // Bounds only mean anything for open pricing — clear them on the way back.
    update.min_price = 0;
    update.max_price = 0;
  }
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
