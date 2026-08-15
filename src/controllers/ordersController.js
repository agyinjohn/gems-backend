const { Order, Product, StockMovement, Tenant } = require('../models');
const { pickSettings, calcDeliveryFee } = require('./storefrontController');
const audit = require('../utils/audit');
const { resolveWriteBranchId } = require('../middleware/branchScope');
const logPayment = require('../utils/paymentLog');
const accounting = require('../services/accountingService');
const { verifyPaystackTransaction, fulfillStorefrontOrders, failStorefrontOrders } = require('../services/paymentService');
const { isFeatureEnabled } = require('../services/tenantService');
const { getActiveSalesTaxRate, calcTaxAmount } = require('../services/taxService');
const splitService = require('../services/splitService');
const { resolveUnitPrice } = require('../services/pricingService');
const { stockLines, shortageFor } = require('../services/stockService');
const { SHOP_TYPES, shopFilter, isShopItem } = require('../services/offeringService');

const generateOrderNumber = () => `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

// Deduct stock for a sold item — nothing for a service, and the stocked parts
// of a solution rather than the solution itself.
async function deductItemStock({ item, tenantId, branchId, orderNumber, createdBy }) {
  const sold = await Product.findById(item.product_id);
  if (!sold) return;
  const isBundle = sold.item_type === 'bundle';

  for (const line of await stockLines({ tenantId, product: sold, quantity: item.quantity })) {
    await Product.findByIdAndUpdate(line.product_id, { $inc: { stock_qty: -line.quantity } });
    await StockMovement.create({
      tenant_id:  tenantId,
      branch_id:  branchId,
      product_id: line.product_id,
      type:       'sale',
      quantity:   -line.quantity,
      reference:  orderNumber,
      ...(isBundle ? { notes: `Bundle: ${sold.name}` } : {}),
      created_by: createdBy,
    });
  }
}

const getOrders = async (req, res) => {
  const { status, payment_status, search } = req.query;
  const filter = { tenant_id: req.tenant_id, ...(req.branchFilter || {}) };
  if (status) filter.status = status;
  if (payment_status) filter.payment_status = payment_status;
  if (search) filter.$or = [{ order_number: new RegExp(search, 'i') }, { customer_name: new RegExp(search, 'i') }];
  const data = await Order.find(filter).populate('created_by', 'name').sort({ createdAt: -1 });
  res.json({ success: true, data });
};

const getOrder = async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  res.json({ success: true, data: order });
};

const createOrder = async (req, res) => {
  const { customer_name, customer_email, customer_phone, delivery_address, items, customer_id, payment_status, payment_method } = req.body;
  if (!customer_name || !items?.length) return res.status(400).json({ success: false, message: 'customer_name and items are required.' });

  let subtotal = 0;
  const enrichedItems = [];
  let hasPhysicalItems = false;
  let hasServiceItems = false;

  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, tenant_id: req.tenant_id, is_active: true });
    if (!p) throw { status: 400, message: `Product ${item.product_id} not found.` };

    const isService = p.item_type === 'service';

    const shortage = await shortageFor({ tenantId: req.tenant_id, product: p, quantity: item.quantity });
    if (shortage) throw { status: 400, message: shortage };

    if (isService) hasServiceItems = true;
    else hasPhysicalItems = true;

    // Staff raise these orders themselves, so an open-price job can be quoted
    // here; fixed-price items still ignore anything the client sends.
    const { unit_price } = resolveUnitPrice({ product: p, proposed: item.unit_price });
    const total = Math.round(unit_price * item.quantity * 100) / 100;
    subtotal += total;
    enrichedItems.push({
      product_id:           p._id,
      product_name:         p.name,
      quantity:             item.quantity,
      unit_price,
      total,
      item_type:            p.item_type || 'product',
      revenue_account_code: p.revenue_account_code || null,
    });
  }

  const isPaid = payment_status !== 'pending';
  const branchId = await resolveWriteBranchId(req);

  // Mixed orders (products + services) start as 'processing'.
  // Pure service orders start as 'pending' until marked 'in_progress'.
  const initialStatus = isPaid
    ? (hasPhysicalItems ? 'processing' : 'pending')
    : 'pending';

  const order = await Order.create({
    tenant_id:      req.tenant_id,
    branch_id:      branchId,
    order_number:   generateOrderNumber(),
    customer_id:    customer_id || null,
    customer_name,  customer_email, customer_phone, delivery_address,
    subtotal,
    total:          subtotal,
    payment_status: isPaid ? 'paid' : 'pending',
    payment_method: isPaid ? (payment_method || 'cash') : null,
    status:         initialStatus,
    source:         'internal',
    items:          enrichedItems,
    created_by:     req.user._id,
  });

  if (isPaid) {
    for (const item of enrichedItems) {
      await deductItemStock({ item, tenantId: req.tenant_id, branchId, orderNumber: order.order_number, createdBy: req.user._id });
    }
    await logPayment({
      tenant_id:   req.tenant_id,
      source:      'internal_order',
      reference:   order.order_number,
      amount:      subtotal,
      method:      payment_method || 'cash',
      status:      'success',
      payer_name:  customer_name,
      payer_email: customer_email,
      description: `Internal order ${order.order_number}`,
      source_id:   order._id,
      recorded_by: req.user._id,
    });
  }

  res.status(201).json({ success: true, message: 'Order created.', data: order });
  await audit(req, 'CREATE_ORDER', 'orders',
    `${req.user.name} created order ${order.order_number} for ${customer_name}`,
    { order_number: order.order_number, total: subtotal, items: enrichedItems.length, payment_status: order.payment_status, has_services: hasServiceItems, has_products: hasPhysicalItems },
  );
};

const updateOrderStatus = async (req, res) => {
  const { status } = req.body;

  // Determine which statuses are valid based on the order's item composition.
  // We fetch the order first so we can apply the right rules.
  const order = await Order.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

  const hasServices  = order.items.some(i => i.item_type === 'service');
  const hasProducts  = order.items.some(i => i.item_type !== 'service');

  // Build the allowed set based on what the order contains:
  //   pure service  → pending, in_progress, completed, cancelled
  //   pure product  → pending, processing, shipped, delivered, cancelled
  //   mixed         → all statuses allowed (operator decides what makes sense)
  let valid;
  if (hasServices && !hasProducts) {
    valid = ['pending', 'in_progress', 'completed', 'cancelled'];
  } else if (hasProducts && !hasServices) {
    valid = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
  } else {
    valid = ['pending', 'processing', 'in_progress', 'shipped', 'delivered', 'completed', 'cancelled'];
  }

  if (!valid.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid status "${status}" for this order type. Allowed: ${valid.join(', ')}.`,
    });
  }

  order.status = status;
  await order.save();

  await audit(req, 'UPDATE_ORDER_STATUS', 'orders',
    `${req.user.name} updated order ${order.order_number} status to "${status}"`,
    { order_number: order.order_number, status },
  );

  // SMS notifications — service orders use 'completed', product orders use 'delivered'
  const notifiable = {
    shipped:    'order_shipped',
    delivered:  'order_delivered',
    completed:  'order_delivered',  // reuse delivered template for service completion
    cancelled:  'order_cancelled',
  };
  if (notifiable[status] && order.customer_phone) {
    const { sendOrderNotification } = require('../services/notificationService');
    sendOrderNotification({
      tenantId:     req.tenant_id,
      order,
      key:          notifiable[status],
      customerPhone: order.customer_phone,
    }).catch(() => {});
  }

  res.json({ success: true, message: 'Order status updated.', data: order });
};

// Storefront — scoped by tenant slug via query param
/**
 * Discount whatever is on offer right now.
 *
 * Lifted out of the catalogue listing so that fetching one product by its own
 * address prices it identically. A shared link showing a higher price than the
 * grid it came from is the kind of discrepancy a customer reads as dishonesty
 * rather than as a bug.
 */
async function applyPromotions(tenantId, items) {
  if (!tenantId || !items.length) return items;

  const { Promotion } = require('../models');
  const now = new Date();
  const promos = await Promotion.find({
    tenant_id: tenantId,
    is_active: true,
    starts_at: { $lte: now },
    $or: [{ ends_at: null }, { ends_at: { $gt: now } }],
  });
  if (!promos.length) return items;

  for (const item of items) {
    const promo = promos.find(pr => {
      if (pr.applies_to === 'all') return true;
      if (pr.applies_to === 'category') return pr.category_ids.some(id => String(id) === String(item.category_id));
      if (pr.applies_to === 'products') return pr.product_ids.some(id => String(id) === String(item.id));
      return false;
    });
    if (!promo) continue;

    const original = item.price;
    const discounted = promo.discount_type === 'percent'
      ? Math.max(0, original - Math.round(original * promo.discount_value / 100))
      : Math.max(0, original - promo.discount_value);
    if (discounted < original) {
      item.compare_price = original;
      item.price = discounted;
      item.promotion_name = promo.name;
    }
  }
  return items;
}

/**
 * A product's specifications, in the order its category defines them.
 *
 * The shape was already here and I nearly built a second one. A category owns
 * `custom_fields` — an ordered list of `{ label, key, type }` — and a product
 * stores the answers in `attributes` keyed by those same keys. So the label a
 * shop typed is already stored; deriving one from the key instead would print
 * "Fabric width" where the shop wrote "Fabric Width (cm)".
 *
 * Anything in `attributes` that the category does not define still shows,
 * appended after. Categories get edited and products get imported, and a
 * specification silently disappearing because somebody renamed a field would
 * be worse than an untidy label.
 */
function showableSpec(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'boolean';
}

function specValue(value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value).trim();
}

function labelFromKey(key) {
  const spaced = String(key).replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : '';
}

function buildSpecs(attributes, category) {
  const attrs = attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? attributes : {};
  const defined = Array.isArray(category?.custom_fields) ? category.custom_fields : [];
  const rows = [];
  const claimed = new Set();

  for (const field of defined) {
    if (!field?.key) continue;
    claimed.add(field.key);
    const value = attrs[field.key];
    if (!showableSpec(value)) continue;
    rows.push({ label: String(field.label || labelFromKey(field.key)), value: specValue(value) });
  }

  for (const [key, value] of Object.entries(attrs)) {
    if (claimed.has(key) || !showableSpec(value)) continue;
    const label = labelFromKey(key);
    if (label) rows.push({ label, value: specValue(value) });
  }

  return rows;
}

/**
 * What a shop's catalogue looks like to the public.
 *
 * Named field by field rather than spread from the document, and that is the
 * point of it. Spreading sent every path on the schema to anybody who called
 * the endpoint — including cost_price, which is what the shop paid. Margins
 * for a whole catalogue, readable by any customer or competitor with a browser,
 * and never rendered anywhere: leaked rather than used. A deliberate list also
 * means the next field added to the schema is not published by accident.
 *
 * Everything here is something the storefront actually shows.
 */
function publicProduct(p) {
  const obj = p.toObject();
  const out = {
    id: p._id,
    name: obj.name,
    slug: obj.slug || '',
    description: obj.description,
    sku: obj.sku,
    images: obj.images || [],
    category: p.category_id?.name,
    category_name: p.category_id?.name,
    // As a plain id, which is not decoration. The promotion matcher below
    // compares this against a promotion's category_ids, and populate had
    // replaced the path with the category document — so String(category_id)
    // was "[object Object]" and never equalled an ObjectId. Category-wide
    // promotions have therefore never applied to a storefront. "All" and
    // per-product ones matched fine, which is why it went unnoticed.
    category_id: p.category_id?._id ? String(p.category_id._id) : undefined,
    branch_id: p.branch_id?._id || obj.branch_id,
    branch_name: p.branch_id?.name,
    branch_slug: p.branch_id?.slug,
    is_active: obj.is_active,

    price: obj.price,
    compare_price: obj.compare_price,

    item_type: obj.item_type,
    // How the thing is measured — "per yard", "per kilo". Stored since the
    // beginning and never sent, so a price by measure read as a price each.
    unit: obj.unit,
    // Resolved against the category, so the labels are the ones the shop
    // typed and the order is the one it chose. attributes still goes out so an
    // older client — or one talking to a newer catalogue than it knows about —
    // can still build a table for itself.
    specs: buildSpecs(obj.attributes, p.category_id),
    attributes: obj.attributes || {},

    short_description: obj.short_description || '',
    brand: obj.brand || '',
    highlights: Array.isArray(obj.highlights) ? obj.highlights.filter(Boolean) : [],

    // Services.
    service_type: obj.service_type,
    unit_type: obj.unit_type,
    duration: obj.duration,
    requires_file: obj.requires_file,

    // Bundles: what is actually inside one.
    bundle_items: (obj.bundle_items || []).map(b => ({
      quantity: b.quantity,
      name: b.product_id?.name,
    })).filter(b => b.name),

    stock_qty: obj.stock_qty,
    low_stock_threshold: obj.low_stock_threshold,
  };
  // A "was" price that is not higher than the price is not a discount.
  if (!out.compare_price || out.compare_price <= out.price) delete out.compare_price;
  return out;
}

/**
 * One product, by the address a customer was given.
 *
 * The same shape and the same pricing as the catalogue listing, because it is
 * the same product — this exists so that a link can be opened, previewed by
 * WhatsApp and read by a search engine, not so that a second version of a
 * product page can drift away from the first.
 *
 * Guarded exactly like the listing: an item withdrawn from the shop, switched
 * off, or priced on request is not reachable by guessing its address.
 */
const getStorefrontProduct = async (req, res) => {
  const { Tenant } = require('../models');
  const tenant = await Tenant.findOne({ slug: req.params.tenantSlug, is_active: true }).select('_id');
  if (!tenant) return res.status(404).json({ success: false, message: 'Store not found.' });

  const product = await Product.findOne({
    tenant_id: tenant._id,
    slug: req.params.productSlug,
    is_active: true,
    pricing_mode: { $ne: 'open' },
    sell_online: { $ne: false },
    // Work is not bought from a shelf, so a service has no shop page even by
    // its address. It is offered at the request desk instead, and a link to
    // one that used to open a buy button now correctly finds nothing here.
    item_type: { $in: SHOP_TYPES },
  })
    .populate('category_id', 'name custom_fields')
    .populate('bundle_items.product_id', 'name')
    .populate('branch_id', 'name slug');

  if (!product || !(await isShopItem(product))) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }

  const [data] = await applyPromotions(tenant._id, [publicProduct(product)]);
  res.json({ success: true, data });
};

const getStorefrontProducts = async (req, res) => {
  const { search, category, page = 1, limit = 12, tenant_slug, branch_slug } = req.query;
  // Open-price items are quoted in person, so they never appear in a
  // self-service catalog. sell_online is the deliberate version of the same
  // decision: absent means yes, which is what everything did before it existed.
  const filter = { is_active: true, pricing_mode: { $ne: 'open' }, sell_online: { $ne: false } };

  // Resolve tenant from slug
  if (tenant_slug) {
    const { Tenant, Branch } = require('../models');
    const t = await Tenant.findOne({ slug: tenant_slug });
    if (!t) return res.status(404).json({ success: false, message: 'Store not found.' });
    filter.tenant_id = t._id;
    if (branch_slug) {
      const b = await Branch.findOne({ tenant_id: t._id, slug: branch_slug });
      if (b) filter.branch_id = b._id;
    }
    // The catalogue is what can be bought. Everything that has to be quoted
    // first is offered at the request desk, which has its own endpoint — see
    // services/offeringService for why a bundle can go either way.
    Object.assign(filter, await shopFilter(t._id));
  } else {
    // Without a shop there is no bundle to look inside, so this falls back to
    // the part of the rule that needs no lookup.
    filter.item_type = { $in: SHOP_TYPES };
  }

  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { description: new RegExp(search, 'i') }];
  if (category) {
    const { Category } = require('../models');
    const cat = await Category.findOne({ name: category, ...(filter.tenant_id ? { tenant_id: filter.tenant_id } : {}) });
    filter.category_id = cat ? cat._id : null;
  }
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [products, total] = await Promise.all([
    Product.find(filter)
      // custom_fields as well as the name: the category is where a
      // specification's label, type and order are defined.
      .populate('category_id', 'name custom_fields')
      // A bundle stores only the ids of what is in it, so without this the
      // storefront can price a package but cannot say what is in it.
      .populate('bundle_items.product_id', 'name')
      // Likewise the branch: the product card has always had a branch badge
      // and has never been sent a branch name to put in it.
      .populate('branch_id', 'name slug')
      .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    Product.countDocuments(filter),
  ]);
  const data = products.map(p => publicProduct(p));
  await applyPromotions(filter.tenant_id, data);

  res.json({ success: true, data, total, page: parseInt(page), hasMore: skip + data.length < total });
};

const initiateCheckout = async (req, res) => {
  const { customer_name, customer_email, customer_phone, delivery_address, delivery_fee, items, tenant_id, branch_id, coupon_code, via_marketplace } = req.body;
  if (!customer_name || !customer_email || !items?.length) return res.status(400).json({ success: false, message: 'customer_name, customer_email and items are required.' });

  // Group items by branch
  const branchGroups = {};
  let resolvedTenantId = tenant_id;
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, is_active: true });
    if (!p) throw { status: 400, message: `Product ${item.product_id} not found.` };
    const shortage = await shortageFor({ tenantId: p.tenant_id, product: p, quantity: item.quantity });
    if (shortage) throw { status: 400, message: shortage };
    if (!resolvedTenantId) resolvedTenantId = p.tenant_id;
    const bId = String(item.branch_id || p.branch_id || 'default');
    if (!branchGroups[bId]) branchGroups[bId] = { branch_id: item.branch_id || p.branch_id || null, branch_name: item.branch_name || 'Main Branch', items: [] };
    branchGroups[bId].items.push({ product: p, quantity: item.quantity });
  }

  const tenantDoc = resolvedTenantId ? await Tenant.findById(resolvedTenantId) : null;
  const storeSettings = tenantDoc ? pickSettings(tenantDoc) : null;
  if (tenantDoc && !(await isFeatureEnabled(tenantDoc.plan || 'starter', 'storefront'))) {
    return res.status(403).json({ success: false, message: 'Online store is not available on this subscription plan.' });
  }
  if (storeSettings && !storeSettings.store_enabled) {
    return res.status(403).json({ success: false, message: 'Online store is currently unavailable.' });
  }

  let cartSubtotal = 0;
  for (const [, group] of Object.entries(branchGroups)) {
    for (const { product: p, quantity } of group.items) {
      // Self-service checkout: an open-price job has no amount to charge, so
      // it is refused rather than sold at a guessed price.
      const { unit_price } = resolveUnitPrice({ product: p, allowOverride: false });
      cartSubtotal += unit_price * quantity;
    }
  }
  if (storeSettings && cartSubtotal < storeSettings.min_order_amount) {
    return res.status(400).json({
      success: false,
      message: `Minimum order amount is GH₵${storeSettings.min_order_amount}.`,
    });
  }

  let discountAmount = 0;
  let appliedCoupon = null;
  if (coupon_code && resolvedTenantId) {
    const { validateCoupon } = require('../services/couponService');
    const couponResult = await validateCoupon({ tenantId: resolvedTenantId, code: coupon_code, subtotal: cartSubtotal });
    if (!couponResult.valid) return res.status(400).json({ success: false, message: couponResult.message });
    discountAmount = couponResult.discount;
    appliedCoupon = couponResult.coupon;
  }

  const discountedSubtotal = Math.max(0, cartSubtotal - discountAmount);

  const resolvedFee = Object.keys(branchGroups).length === 1
    ? (delivery_fee !== undefined && delivery_fee !== null
      ? parseFloat(delivery_fee) || 0
      : (storeSettings ? calcDeliveryFee(discountedSubtotal, storeSettings) : 0))
    : 0;

  const salesTax = resolvedTenantId ? await getActiveSalesTaxRate(resolvedTenantId) : null;
  const taxRatePct = salesTax?.rate || 0;

  const paystackRef = `GEMS-${Date.now()}`;

  const branchKeys = Object.keys(branchGroups);
  const branchDiscountShare = branchKeys.length && discountAmount
    ? discountAmount / branchKeys.length
    : 0;

  // Create one order per branch
  const orders = [];
  for (const [, group] of Object.entries(branchGroups)) {
    let subtotal = 0;
    const enrichedItems = [];
    for (const { product: p, quantity } of group.items) {
      const { unit_price } = resolveUnitPrice({ product: p, allowOverride: false });
      const total = Math.round(unit_price * quantity * 100) / 100;
      subtotal += total;
      enrichedItems.push({
        product_id:           p._id,
        product_name:         p.name,
        quantity,
        unit_price,
        total,
        item_type:            p.item_type || 'product',
        revenue_account_code: p.revenue_account_code || null,
      });
    }
    const branchDiscount = Math.min(subtotal, branchDiscountShare);
    const taxableSubtotal = Math.max(0, subtotal - branchDiscount);
    const fee = resolvedFee;
    const tax_amount = calcTaxAmount(taxableSubtotal, taxRatePct);
    const total = taxableSubtotal + fee + tax_amount;
    const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const order = await Order.create({
      tenant_id: resolvedTenantId,
      branch_id: group.branch_id,
      order_number: orderNumber,
      customer_name, customer_email, customer_phone, delivery_address,
      subtotal, discount_amount: branchDiscount,
      coupon_code: appliedCoupon?.code || null,
      tax_amount, total,
      payment_status: 'pending',
      payment_ref: paystackRef,
      status: 'pending',
      source: 'storefront',
      via_marketplace: !!via_marketplace,
      items: enrichedItems,
    });
    orders.push({ order_id: order._id, order_number: orderNumber, total, branch_name: group.branch_name, discount: branchDiscount });
  }

  const grandTotal = orders.reduce((s, o) => s + o.total, 0);

  // Split-enabled tenants are paid at the gateway: their share settles straight
  // to their own subaccount, so these orders are marked as settled and stay out
  // of the withdrawable platform balance. A checkout is one Paystack
  // transaction, so the commission is worked out on the whole total and then
  // apportioned across the orders it produced.
  const split = await splitService.buildSplitForCheckout({
    tenantId: resolvedTenantId,
    amount: grandTotal,
    viaMarketplace: !!via_marketplace,
  });

  if (split) {
    let allocated = 0;
    for (let i = 0; i < orders.length; i++) {
      const isLast = i === orders.length - 1;
      // Give the rounding remainder to the last order so the apportioned fees
      // add up to exactly the commission charged at the gateway.
      const fee = isLast
        ? Math.round((split.commission - allocated) * 100) / 100
        : Math.round((split.commission * (orders[i].total / grandTotal)) * 100) / 100;
      allocated = Math.round((allocated + fee) * 100) / 100;

      await Order.findByIdAndUpdate(orders[i].order_id, {
        split_settled: true,
        subaccount_code: split.subaccount,
        platform_fee: fee,
      });
    }
  }

  res.status(201).json({
    success: true,
    data: {
      orders,
      grand_total: grandTotal,
      discount_amount: discountAmount,
      coupon_code: appliedCoupon?.code || null,
      email: customer_email,
      paystack_public_key: process.env.PAYSTACK_PUBLIC_KEY,
      reference: paystackRef,
      tax_rate: taxRatePct,
      tax_name: salesTax?.name || '',
      // Passed straight through to Paystack Inline when the tenant is
      // split-enabled; absent otherwise.
      ...(split && { subaccount: split.subaccount, transaction_charge: split.transaction_charge }),
    },
  });
};

const verifyPayment = async (req, res) => {
  const { reference, order_ids } = req.body;
  if (!reference || !order_ids?.length) return res.status(400).json({ success: false, message: 'reference and order_ids required.' });

  try {
    await verifyPaystackTransaction(reference);
    const result = await fulfillStorefrontOrders({ reference, orderIds: order_ids });
    res.json({ success: true, message: 'Payment verified. Orders confirmed!', data: result });
  } catch (err) {
    const status = err.message?.includes('not configured') ? 500 : 400;
    res.status(status).json({ success: false, message: err.message || 'Payment verification failed.' });
  }
};

module.exports = {
  getStorefrontProduct, getOrders, getOrder, createOrder, updateOrderStatus, getStorefrontProducts, initiateCheckout, verifyPayment, deductItemStock };
