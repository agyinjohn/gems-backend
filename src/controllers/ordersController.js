const { Order, Product, StockMovement, Tenant } = require('../models');
const { pickSettings, calcDeliveryFee } = require('./storefrontController');
const audit = require('../utils/audit');
const { resolveWriteBranchId } = require('../middleware/branchScope');
const logPayment = require('../utils/paymentLog');
const accounting = require('../services/accountingService');
const { verifyPaystackTransaction, fulfillStorefrontOrders, failStorefrontOrders } = require('../services/paymentService');
const { isFeatureEnabled } = require('../services/tenantService');
const { getActiveSalesTaxRate, calcTaxAmount } = require('../services/taxService');

const generateOrderNumber = () => `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

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
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, tenant_id: req.tenant_id, is_active: true });
    if (!p) throw { status: 400, message: `Product ${item.product_id} not found.` };
    if (p.stock_qty < item.quantity) throw { status: 400, message: `Insufficient stock for ${p.name}.` };
    const total = p.price * item.quantity;
    subtotal += total;
    enrichedItems.push({ product_id: p._id, product_name: p.name, quantity: item.quantity, unit_price: p.price, total });
  }
  const isPaid = payment_status !== 'pending';
  const branchId = await resolveWriteBranchId(req);
  const order = await Order.create({ tenant_id: req.tenant_id, branch_id: branchId, order_number: generateOrderNumber(), customer_id: customer_id || null, customer_name, customer_email, customer_phone, delivery_address, subtotal, total: subtotal, payment_status: isPaid ? 'paid' : 'pending', payment_method: isPaid ? (payment_method || 'cash') : null, status: isPaid ? 'processing' : 'pending', source: 'internal', items: enrichedItems, created_by: req.user._id });
  if (isPaid) {
    for (const item of enrichedItems) {
      await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: -item.quantity } });
      await StockMovement.create({ tenant_id: req.tenant_id, branch_id: branchId, product_id: item.product_id, type: 'sale', quantity: -item.quantity, reference: order.order_number, created_by: req.user._id });
    }
    await logPayment({ tenant_id: req.tenant_id, source: 'internal_order', reference: order.order_number, amount: subtotal, method: payment_method || 'cash', status: 'success', payer_name: customer_name, payer_email: customer_email, description: `Internal order ${order.order_number}`, source_id: order._id, recorded_by: req.user._id });
  }
  res.status(201).json({ success: true, message: 'Order created.', data: order });
  await audit(req, 'CREATE_ORDER', 'orders', `${req.user.name} created order ${order.order_number} for ${customer_name}`, { order_number: order.order_number, total: subtotal, items: enrichedItems.length, payment_status: order.payment_status, payment_method: order.payment_method });
};

const updateOrderStatus = async (req, res) => {
  const { status } = req.body;
  const valid = ['pending','processing','shipped','delivered','cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
  const order = await Order.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { status }, { new: true });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  await audit(req, 'UPDATE_ORDER_STATUS', 'orders', `${req.user.name} updated order ${order.order_number} status to "${status}"`, { order_number: order.order_number, status });
  res.json({ success: true, message: 'Order status updated.', data: order });
};

// Storefront — scoped by tenant slug via query param
const getStorefrontProducts = async (req, res) => {
  const { search, category, page = 1, limit = 12, tenant_slug, branch_slug } = req.query;
  const filter = { is_active: true };

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
  }

  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { description: new RegExp(search, 'i') }];
  if (category) {
    const { Category } = require('../models');
    const cat = await Category.findOne({ name: category, ...(filter.tenant_id ? { tenant_id: filter.tenant_id } : {}) });
    filter.category_id = cat ? cat._id : null;
  }
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [products, total] = await Promise.all([
    Product.find(filter).populate('category_id', 'name').sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    Product.countDocuments(filter),
  ]);
  const data = products.map(p => {
    const obj = { ...p.toObject(), id: p._id, category: p.category_id?.name, category_name: p.category_id?.name };
    if (!obj.compare_price || obj.compare_price <= obj.price) delete obj.compare_price;
    return obj;
  });

  // Apply active promotions — set compare_price to original and discount price
  if (filter.tenant_id) {
    const { Promotion } = require('../models');
    const now = new Date();
    const promos = await Promotion.find({
      tenant_id: filter.tenant_id,
      is_active: true,
      starts_at: { $lte: now },
      $or: [{ ends_at: null }, { ends_at: { $gt: now } }],
    });
    if (promos.length) {
      for (const item of data) {
        const promo = promos.find(pr => {
          if (pr.applies_to === 'all') return true;
          if (pr.applies_to === 'category') return pr.category_ids.some(id => String(id) === String(item.category_id));
          if (pr.applies_to === 'products') return pr.product_ids.some(id => String(id) === String(item._id || item.id));
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
    }
  }

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
    if (p.stock_qty < item.quantity) throw { status: 400, message: `Insufficient stock for ${p.name}.` };
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
      cartSubtotal += p.price * quantity;
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
      const total = p.price * quantity;
      subtotal += total;
      enrichedItems.push({ product_id: p._id, product_name: p.name, quantity, unit_price: p.price, total });
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

module.exports = { getOrders, getOrder, createOrder, updateOrderStatus, getStorefrontProducts, initiateCheckout, verifyPayment };
