const express = require('express');
const router = express.Router();
const { authenticate, authorize, superAdminOnly, platformAdminOnly, businessOwnerOnly, requireTenant } = require('../middleware/auth');
const auditMiddleware = require('../middleware/auditMiddleware');
const auth = require('../controllers/authController');
const users = require('../controllers/usersController');
const dashboard = require('../controllers/dashboardController');
const inventory = require('../controllers/inventoryController');
const orders = require('../controllers/ordersController');
const tenant = require('../controllers/tenantController');
const branch = require('../controllers/branchController');
const logPayment = require('../utils/paymentLog');
const accounting = require('../services/accountingService');
const accountingRouter = require('./accounting');
const {
  Supplier, PurchaseOrder, Product, StockMovement,
  Account, Expense, JournalEntry,
  Department, Employee, Attendance, LeaveRequest, PayrollRun,
  Customer, Lead, ContactHistory, Order,
} = require('../models');

// AUTH
router.post('/auth/login', auth.login);
router.get('/auth/me', authenticate, auth.getMe);
router.post('/auth/change-password', authenticate, auth.changePassword);
router.post('/auth/forgot-password', auth.forgotPassword);
router.post('/auth/reset-password', auth.resetPassword);

// TENANT REGISTRATION (public)
router.post('/tenants/register', tenant.registerTenant);

// Audit middleware — only runs for authenticated requests, skips public routes
router.use((req, res, next) => {
  if (req.user) return auditMiddleware(req, res, next);
  next();
});

// PLATFORM ADMIN — tenant management (us only)
router.get('/platform/tenants', authenticate, platformAdminOnly, tenant.getAllTenants);
router.get('/platform/tenants/:id', authenticate, platformAdminOnly, tenant.getTenant);
router.patch('/platform/tenants/:id', authenticate, platformAdminOnly, tenant.updateTenant);
router.patch('/platform/tenants/:id/suspend', authenticate, platformAdminOnly, tenant.suspendTenant);
router.patch('/platform/tenants/:id/activate', authenticate, platformAdminOnly, tenant.activateTenant);

// MY TENANT — business owner sees their own tenant
router.get('/my-tenant', authenticate, requireTenant, tenant.getMyTenant);

// BRANCHES
router.get('/branches', authenticate, requireTenant, branch.getBranches);
router.post('/branches', authenticate, requireTenant, businessOwnerOnly, branch.createBranch);
router.put('/branches/:id', authenticate, requireTenant, businessOwnerOnly, branch.updateBranch);
router.delete('/branches/:id', authenticate, requireTenant, businessOwnerOnly, branch.deleteBranch);
router.get('/branches/:id/staff', authenticate, requireTenant, branch.getBranchStaff);

// USERS
router.get('/users', authenticate, requireTenant, businessOwnerOnly, users.getUsers);
router.get('/users/:id', authenticate, requireTenant, businessOwnerOnly, users.getUser);
router.post('/users', authenticate, requireTenant, businessOwnerOnly, users.createUser);
router.put('/users/:id', authenticate, requireTenant, businessOwnerOnly, users.updateUser);
router.delete('/users/:id', authenticate, requireTenant, businessOwnerOnly, users.deleteUser);

// BILLING
const billing = require('../controllers/billingController');
router.get('/billing/status',         authenticate, requireTenant, billing.getStatus);
router.get('/billing/transactions',   authenticate, requireTenant, billing.getTransactions);
router.get('/billing/card',           authenticate, requireTenant, billing.getCard);
router.post('/billing/subscribe',     authenticate, requireTenant, businessOwnerOnly, billing.subscribe);
router.post('/billing/verify',        authenticate, requireTenant, businessOwnerOnly, billing.verify);
router.post('/billing/authorize-card',authenticate, requireTenant, businessOwnerOnly, billing.authorizeCard);
router.post('/billing/save-card',     authenticate, requireTenant, businessOwnerOnly, billing.saveCard);
router.post('/billing/cancel',        authenticate, requireTenant, businessOwnerOnly, billing.cancelSubscription);

// GET /billing/callback?reference=xxx — called by frontend after Paystack card redirect
router.get('/billing/callback', authenticate, requireTenant, async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.status(400).json({ success: false, message: 'reference required.' });
  // Reuse save-card logic by forwarding as a POST body
  req.body = { reference };
  return billing.saveCard(req, res);
});

// PLATFORM SETTINGS
router.get('/platform/settings', authenticate, platformAdminOnly, async (req, res) => {
  const { PlatformSettings } = require('../models');
  let settings = await PlatformSettings.findOne();
  if (!settings) settings = await PlatformSettings.create({});
  // Mask secret key in response
  const data = settings.toJSON();
  if (data.paystack_secret_key) data.paystack_secret_key = '••••••••' + data.paystack_secret_key.slice(-4);
  res.json({ success: true, data });
});
router.put('/platform/settings', authenticate, platformAdminOnly, async (req, res) => {
  const { PlatformSettings } = require('../models');
  const {
    trial_days, grace_days, plans, currency, auto_renew_default,
    platform_name, support_email, platform_logo,
    paystack_public_key, paystack_secret_key, paystack_webhook_url,
    trial_warning_days, expiry_alert_days,
    audit_retention_days, feature_flags,
  } = req.body;
  let settings = await PlatformSettings.findOne();
  if (!settings) settings = new PlatformSettings();
  const fields = {
    trial_days, grace_days, currency, auto_renew_default,
    platform_name, support_email, platform_logo,
    paystack_public_key, paystack_webhook_url,
    trial_warning_days, expiry_alert_days, audit_retention_days,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) settings[k] = v;
  }
  // Only update secret key if a real value (not masked) is provided
  if (paystack_secret_key && !paystack_secret_key.startsWith('••••')) {
    settings.paystack_secret_key = paystack_secret_key;
  }
  if (plans !== undefined) { settings.plans = plans; settings.markModified('plans'); }
  if (feature_flags !== undefined) { settings.feature_flags = feature_flags; settings.markModified('feature_flags'); }
  await settings.save();
  const data = settings.toJSON();
  if (data.paystack_secret_key) data.paystack_secret_key = '••••••••' + data.paystack_secret_key.slice(-4);
  res.json({ success: true, data });
});

// Public plan prices — used by billing page (no auth required)
router.get('/plan-prices', async (req, res) => {
  const { PlatformSettings } = require('../models');
  const settings = await PlatformSettings.findOne();
  const plans = settings?.plans || {
    starter:    { price: 29,  max_branches: 1,   max_users: 5   },
    pro:        { price: 79,  max_branches: 5,   max_users: 20  },
    enterprise: { price: 199, max_branches: 999, max_users: 999 },
  };
  res.json({ success: true, data: { plans } });
});

// AUDIT LOGS
router.get('/audit-logs', authenticate, async (req, res) => {
  const { AuditLog } = require('../models');
  const { module: mod, action, user_id, from, to, page = 1, limit = 50 } = req.query;
  const filter = {};

  // Platform admin sees all, tenant users see only their tenant
  if (req.user.role !== 'platform_admin') filter.tenant_id = req.tenant_id;

  if (mod)     filter.module = mod;
  if (action)  filter.action = new RegExp(action, 'i');
  if (user_id) filter.user_id = user_id;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to)   filter.createdAt.$lte = new Date(to + 'T23:59:59');
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ success: true, data: logs, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

// DASHBOARD
router.get('/dashboard', authenticate, requireTenant, dashboard.getDashboard);

// INVENTORY
// Allow public access when tenant_slug query param is present (storefront)
router.get('/categories', (req, res, next) => {
  if (req.query.tenant_slug) return next();
  authenticate(req, res, () => requireTenant(req, res, next));
}, inventory.getCategories);
router.post('/categories', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), inventory.createCategory);
router.put('/categories/:id', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), inventory.updateCategory);
router.delete('/categories/:id', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), inventory.deleteCategory);
router.get('/products', authenticate, requireTenant, inventory.getProducts);
router.get('/products/:id', authenticate, requireTenant, inventory.getProduct);
router.post('/products', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), inventory.createProduct);
router.put('/products/:id', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), inventory.updateProduct);
router.delete('/products/:id', authenticate, requireTenant, businessOwnerOnly, inventory.deleteProduct);
router.post('/products/:id/adjust-stock', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), inventory.adjustStock);
router.get('/products/:id/movements', authenticate, requireTenant, inventory.getStockMovements);

// POS
router.post('/pos/sale', authenticate, requireTenant, authorize('business_owner', 'sales_staff'), async (req, res) => {
  const { items, payment_method, amount_tendered, customer_name, customer_phone } = req.body;
  if (!items?.length) return res.status(400).json({ success: false, message: 'items required.' });
  let subtotal = 0;
  const enrichedItems = [];
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, tenant_id: req.tenant_id, is_active: true });
    if (!p) return res.status(400).json({ success: false, message: `Product not found.` });
    if (p.stock_qty < item.quantity) return res.status(400).json({ success: false, message: `Insufficient stock for ${p.name}.` });
    const total = p.price * item.quantity;
    subtotal += total;
    enrichedItems.push({ product_id: p._id, product_name: p.name, quantity: item.quantity, unit_price: p.price, total });
  }
  const orderNumber = `POS-${Date.now()}-${Math.floor(Math.random() * 100)}`;
  const order = await Order.create({
    tenant_id: req.tenant_id,
    order_number: orderNumber,
    customer_name: customer_name || 'Walk-in Customer',
    customer_phone: customer_phone || '',
    subtotal, total: subtotal,
    payment_status: 'paid',
    payment_method: payment_method || 'cash',
    status: 'delivered',
    source: 'pos',
    items: enrichedItems,
    created_by: req.user._id,
  });
  for (const item of enrichedItems) {
    await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: -item.quantity } });
    await StockMovement.create({ tenant_id: req.tenant_id, product_id: item.product_id, type: 'sale', quantity: -item.quantity, reference: orderNumber, created_by: req.user._id });
  }
  await logPayment({ tenant_id: req.tenant_id, source: 'pos', reference: orderNumber, amount: subtotal, method: payment_method || 'cash', status: 'success', payer_name: customer_name || 'Walk-in Customer', description: `POS sale ${orderNumber}`, source_id: order._id, recorded_by: req.user._id });
  await accounting.postSaleEntry({ tenantId: req.tenant_id, amount: subtotal, cogsAmount: 0, reference: orderNumber, date: new Date(), sourceId: order._id, createdBy: req.user._id }).catch(err => console.error('[POS] GL posting failed:', err.message));
  res.status(201).json({ success: true, data: { ...order.toJSON(), amount_tendered, change: (amount_tendered || subtotal) - subtotal } });
});

router.get('/pos/products', authenticate, requireTenant, async (req, res) => {
  const { search, category } = req.query;
  const filter = { tenant_id: req.tenant_id, is_active: true };
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { sku: new RegExp(search, 'i') }];
  if (category) {
    const { Category } = require('../models');
    const cat = await Category.findOne({ tenant_id: req.tenant_id, name: category });
    if (cat) filter.category_id = cat._id;
  }
  const products = await Product.find(filter).populate('category_id', 'name').sort('name').limit(200);
  const data = products.map(p => ({ ...p.toObject(), id: p._id, category_name: p.category_id?.name || 'General', barcode: p.barcode || null }));
  res.json({ success: true, data });
});

// ORDERS
router.get('/orders', authenticate, requireTenant, orders.getOrders);
router.get('/orders/:id/invoice', authenticate, requireTenant, async (req, res) => {
  const { Tenant } = require('../models');
  const order = await Order.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  const business = await Tenant.findById(req.tenant_id).select('business_name email phone address logo');
  res.json({ success: true, data: { order, business } });
});
router.get('/orders/:id', authenticate, requireTenant, orders.getOrder);
router.post('/orders', authenticate, requireTenant, authorize('business_owner', 'sales_staff'), orders.createOrder);
router.patch('/orders/:id/status', authenticate, requireTenant, authorize('business_owner', 'sales_staff'), orders.updateOrderStatus);
router.patch('/orders/:id/pay', authenticate, requireTenant, authorize('business_owner', 'sales_staff', 'accountant'), async (req, res) => {
  const { payment_method } = req.body;
  const order = await Order.findOne({ _id: req.params.id, tenant_id: req.tenant_id, payment_status: 'pending', source: 'internal' });
  if (!order) return res.status(404).json({ success: false, message: 'Order not found or already paid.' });
  order.payment_status = 'paid';
  order.payment_method = payment_method || 'cash';
  order.status = 'processing';
  await order.save();
  for (const item of order.items) {
    await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: -item.quantity } });
    await StockMovement.create({ tenant_id: req.tenant_id, product_id: item.product_id, type: 'sale', quantity: -item.quantity, reference: order.order_number, created_by: req.user._id });
  }
  await logPayment({ tenant_id: req.tenant_id, source: 'internal_order', reference: order.order_number, amount: order.total, method: payment_method || 'cash', status: 'success', payer_name: order.customer_name, payer_email: order.customer_email, description: `Payment collected for order ${order.order_number}`, source_id: order._id, recorded_by: req.user._id });
  await accounting.postSaleEntry({ tenantId: req.tenant_id, amount: order.total, cogsAmount: order.subtotal, taxAmount: order.tax_amount || 0, reference: order.order_number, date: new Date(), sourceId: order._id, createdBy: req.user._id }).catch(() => {});
  res.json({ success: true, message: 'Order marked as paid.', data: order });
});

// STOREFRONT
router.get('/storefront/:tenantSlug/branches', async (req, res) => {
  const { Tenant, Branch } = require('../models');
  const tenant = await Tenant.findOne({ slug: req.params.tenantSlug, is_active: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Store not found.' });
  const branches = await Branch.find({ tenant_id: tenant._id, is_active: true }).sort('name');
  res.json({ success: true, data: { tenant: { id: tenant._id, business_name: tenant.business_name, slug: tenant.slug, logo: tenant.logo }, branches } });
});

router.get('/storefront/products', orders.getStorefrontProducts);
router.get('/storefront/categories', async (req, res) => {
  const { Category } = require('../models');
  const data = await Category.find().sort('name');
  res.json({ success: true, data });
});
router.post('/storefront/checkout', orders.initiateCheckout);
router.post('/storefront/verify-payment', orders.verifyPayment);
router.get('/storefront/orders/:orderNumber', async (req, res) => {
  const order = await Order.findOne({ order_number: req.params.orderNumber, source: 'storefront' })
    .select('order_number status payment_status customer_name delivery_address items total createdAt branch_id');
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  res.json({ success: true, data: order });
});

// STOREFRONT CART
const { Cart } = require('../models');

const getOrCreateCart = async (cart_id, tenant_id) => {
  if (cart_id) {
    const cart = await Cart.findOne({ cart_id });
    if (cart) return cart;
  }
  const newId = require('crypto').randomUUID();
  return await Cart.create({ cart_id: newId, tenant_id, items: [] });
};

router.get('/storefront/cart/:cartId', async (req, res) => {
  const cart = await Cart.findOne({ cart_id: req.params.cartId });
  if (!cart) return res.json({ success: true, data: { cart_id: req.params.cartId, items: [] } });
  res.json({ success: true, data: cart });
});

router.post('/storefront/cart/add', async (req, res) => {
  const { cart_id, product_id, quantity = 1, tenant_id } = req.body;
  if (!product_id) return res.status(400).json({ success: false, message: 'product_id required.' });
  const product = await Product.findOne({ _id: product_id, is_active: true }).populate('category_id', 'name').populate('branch_id', 'name slug');
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
  const cart = await getOrCreateCart(cart_id, tenant_id || product.tenant_id);
  const existing = cart.items.find(i => String(i.product_id) === String(product._id));
  if (existing) {
    existing.quantity = Math.min(existing.quantity + quantity, product.stock_qty);
  } else {
    cart.items.push({
      product_id: product._id,
      product_name: product.name,
      price: product.price,
      quantity: Math.min(quantity, product.stock_qty),
      images: product.images,
      category_name: product.category_id?.name || '',
      stock_qty: product.stock_qty,
      low_stock_threshold: product.low_stock_threshold,
      sku: product.sku,
      branch_id: product.branch_id?._id || product.branch_id || null,
      branch_name: product.branch_id?.name || 'Main Branch',
      branch_slug: product.branch_id?.slug || 'main',
    });
  }
  cart.expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await cart.save();
  res.json({ success: true, data: cart });
});

router.patch('/storefront/cart/update', async (req, res) => {
  const { cart_id, product_id, quantity } = req.body;
  if (!cart_id || !product_id) return res.status(400).json({ success: false, message: 'cart_id and product_id required.' });
  const cart = await Cart.findOne({ cart_id });
  if (!cart) return res.status(404).json({ success: false, message: 'Cart not found.' });
  if (quantity <= 0) {
    cart.items = cart.items.filter(i => String(i.product_id) !== String(product_id));
  } else {
    const item = cart.items.find(i => String(i.product_id) === String(product_id));
    if (item) item.quantity = quantity;
  }
  await cart.save();
  res.json({ success: true, data: cart });
});

router.delete('/storefront/cart/:cartId', async (req, res) => {
  await Cart.findOneAndUpdate({ cart_id: req.params.cartId }, { items: [] });
  res.json({ success: true, data: { cart_id: req.params.cartId, items: [] } });
});

// PAYMENT LOGS
router.get('/payment-logs', authenticate, requireTenant, async (req, res) => {
  const { source, status, from, to, page = 1, limit = 50 } = req.query;
  const filter = { tenant_id: req.tenant_id };
  if (source) filter.source = source;
  if (status) filter.status = status;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to)   filter.createdAt.$lte = new Date(to + 'T23:59:59');
  }
  const { PaymentLog } = require('../models');
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [logs, total] = await Promise.all([
    PaymentLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    PaymentLog.countDocuments(filter),
  ]);
  const summary = await PaymentLog.aggregate([
    { $match: { tenant_id: filter.tenant_id, status: 'success' } },
    { $group: { _id: '$source', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  res.json({ success: true, data: logs, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), summary });
});

// SUPPLIERS
router.get('/suppliers', authenticate, requireTenant, async (req, res) => {
  const data = await Supplier.find({ tenant_id: req.tenant_id, is_active: true }).sort('name');
  res.json({ success: true, data });
});
router.post('/suppliers', authenticate, requireTenant, authorize('business_owner','procurement_officer'), async (req, res) => {
  const { name, email, phone, address, payment_terms, notes } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Supplier name is required.' });
  const data = await Supplier.create({ tenant_id: req.tenant_id, name, email, phone, address, payment_terms, notes });
  res.status(201).json({ success: true, data });
});
router.put('/suppliers/:id', authenticate, requireTenant, authorize('business_owner','procurement_officer'), async (req, res) => {
  const { name, email, phone, address, payment_terms, notes } = req.body;
  const data = await Supplier.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { name, email, phone, address, payment_terms, notes }, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Supplier not found.' });
  res.json({ success: true, data });
});
router.delete('/suppliers/:id', authenticate, requireTenant, authorize('business_owner','procurement_officer'), async (req, res) => {
  await Supplier.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { is_active: false });
  res.json({ success: true, message: 'Supplier deactivated.' });
});

// PURCHASE ORDERS
router.get('/purchase-orders', authenticate, requireTenant, async (req, res) => {
  const filter = { tenant_id: req.tenant_id };
  if (req.query.status) {
    const statuses = req.query.status.split(',');
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (req.query.payment_status) filter.payment_status = req.query.payment_status;
  const data = await PurchaseOrder.find(filter).populate('supplier_id', 'name').sort({ createdAt: -1 });
  res.json({ success: true, data });
});
router.get('/purchase-orders/:id', authenticate, requireTenant, async (req, res) => {
  const po = await PurchaseOrder.findOne({ _id: req.params.id, tenant_id: req.tenant_id }).populate('supplier_id', 'name');
  if (!po) return res.status(404).json({ success: false, message: 'PO not found.' });
  res.json({ success: true, data: po });
});
router.post('/purchase-orders', authenticate, requireTenant, authorize('business_owner','procurement_officer'), async (req, res) => {
  const { supplier_id, expected_date, notes, items } = req.body;
  if (!supplier_id || !items?.length) return res.status(400).json({ success: false, message: 'supplier_id and items required.' });
  let total_cost = 0;
  const enriched = [];
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, tenant_id: req.tenant_id });
    if (!p) return res.status(400).json({ success: false, message: 'Product not found.' });
    const itemTotal = parseFloat(item.unit_cost) * parseInt(item.quantity_ordered);
    total_cost += itemTotal;
    enriched.push({ product_id: p._id, product_name: p.name, quantity_ordered: item.quantity_ordered, unit_cost: item.unit_cost, total: itemTotal });
  }
  const po = await PurchaseOrder.create({ tenant_id: req.tenant_id, branch_id: req.user.branch_id || null, po_number: `PO-${Date.now()}`, supplier_id, total_cost, items: enriched, notes, expected_date: expected_date || null, created_by: req.user._id });
  res.status(201).json({ success: true, data: po });
});
router.patch('/purchase-orders/:id/approve', authenticate, requireTenant, authorize('business_owner','accountant'), async (req, res) => {
  const po = await PurchaseOrder.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { status: 'approved', approved_by: req.user._id, approved_at: new Date() }, { new: true });
  res.json({ success: true, data: po });
});
router.patch('/purchase-orders/:id/send', authenticate, requireTenant, authorize('business_owner','procurement_officer'), async (req, res) => {
  const po = await PurchaseOrder.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!po) return res.status(404).json({ success: false, message: 'PO not found.' });
  if (po.status !== 'approved') return res.status(400).json({ success: false, message: 'Only approved POs can be marked as sent.' });
  po.status = 'sent';
  await po.save();
  res.json({ success: true, data: po });
});
router.patch('/purchase-orders/:id/pay', authenticate, requireTenant, authorize('business_owner','accountant','procurement_officer'), async (req, res) => {
  const po = await PurchaseOrder.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!po) return res.status(404).json({ success: false, message: 'PO not found.' });
  if (po.payment_status === 'paid') return res.status(400).json({ success: false, message: 'Already fully paid.' });

  const { amount, method = 'bank_transfer', reference, note } = req.body;

  // Calculate how much is still outstanding on this PO
  const alreadyPaid = po.amount_paid || 0;
  const outstanding = po.total_cost - alreadyPaid;
  const paying = amount ? Math.min(parseFloat(amount), outstanding) : outstanding;
  if (paying <= 0) return res.status(400).json({ success: false, message: 'Nothing left to pay on this PO.' });

  po.amount_paid = parseFloat((alreadyPaid + paying).toFixed(2));
  po.payment_status = po.amount_paid >= po.total_cost - 0.01 ? 'paid' : 'partial';
  if (po.payment_status === 'paid') po.paid_at = new Date();

  // Store payment record on the PO
  if (!po.payments) po.payments = [];
  po.payments.push({ amount: paying, method, reference: reference || null, note: note || null, date: new Date() });
  await po.save();

  await logPayment({ tenant_id: req.tenant_id, source: 'purchase_order', reference: po.po_number, amount: paying, method, status: 'success', description: `Supplier payment — ${po.po_number}${reference ? ' ref: ' + reference : ''}`, source_id: po._id, recorded_by: req.user._id });

  // Post GL: Dr Accounts Payable / Cr Cash & Bank (for the amount actually paid)
  await accounting.postPurchasePaymentEntry({ tenantId: req.tenant_id, amount: paying, reference: `${po.po_number}-${Date.now()}`, date: new Date(), sourceId: po._id, createdBy: req.user._id }).catch(() => {});

  res.json({ success: true, data: po, paid: paying, outstanding: parseFloat((po.total_cost - po.amount_paid).toFixed(2)) });
});
router.post('/purchase-orders/:id/receive', authenticate, requireTenant, authorize('business_owner','warehouse_staff','procurement_officer'), async (req, res) => {
  const { items } = req.body;
  const po = await PurchaseOrder.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!po) return res.status(404).json({ success: false, message: 'PO not found.' });
  let receivedTotal = 0;
  for (const item of items) {
    if (!item.receive_qty || item.receive_qty <= 0) continue;
    const line = po.items.id(item._id);
    if (line) {
      line.quantity_received += item.receive_qty;
      receivedTotal += item.receive_qty * (line.unit_cost || 0);
    }
    await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: item.receive_qty } });
    await StockMovement.create({ tenant_id: req.tenant_id, product_id: item.product_id, type: 'purchase', quantity: item.receive_qty, reference: po.po_number, created_by: req.user._id });
  }
  const allDone = po.items.every(i => i.quantity_received >= i.quantity_ordered);
  const anyDone = po.items.some(i => i.quantity_received > 0);
  po.status = allDone ? 'completed' : anyDone ? 'partially_received' : 'approved';
  await po.save();
  if (receivedTotal > 0) {
    await accounting.postPurchaseOrderEntry({ tenantId: req.tenant_id, amount: receivedTotal, reference: po.po_number, date: new Date(), sourceId: po._id, createdBy: req.user._id }).catch(() => {});
  }
  res.json({ success: true, message: 'Goods received.' });
});


router.get('/notifications', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const [lowStock, pendingLeave, pendingOrders, pendingPOs] = await Promise.all([
    Product.find({ tenant_id: tid, is_active: true, $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] } }).sort('stock_qty').limit(5),
    LeaveRequest.find({ tenant_id: tid, status: 'pending' }).populate('employee_id', 'name').sort({ createdAt: -1 }).limit(5),
    Order.find({ tenant_id: tid, payment_status: 'pending' }).sort({ createdAt: -1 }).limit(5),
    PurchaseOrder.find({ tenant_id: tid, status: 'pending_approval' }).sort({ createdAt: -1 }).limit(5),
  ]);
  const notifications = [
    ...lowStock.map(p => ({ id: `ls-${p._id}`, type: 'warning', title: 'Low Stock', message: `${p.name} has only ${p.stock_qty} units left`, link: '/inventory' })),
    ...pendingLeave.map(l => ({ id: `lv-${l._id}`, type: 'info', title: 'Leave Request', message: `${l.employee_id?.name || 'Employee'} requested ${l.leave_type} leave`, link: '/hr' })),
    ...pendingOrders.map(o => ({ id: `or-${o._id}`, type: 'info', title: 'Unpaid Order', message: `Order ${o.order_number} from ${o.customer_name} is pending payment`, link: '/orders' })),
    ...pendingPOs.map(p => ({ id: `po-${p._id}`, type: 'warning', title: 'PO Awaiting Approval', message: `${p.po_number} needs approval`, link: '/procurement' })),
  ];
  res.json({ success: true, data: notifications });
});

// EMPLOYEE SELF-SERVICE
router.get('/ess/me', authenticate, async (req, res) => {
  const employee = await Employee.findOne({ user_id: req.user._id }).populate('department_id', 'name');
  res.json({ success: true, data: employee ? { ...employee.toJSON(), department_name: employee.department_id?.name } : null });
});
router.get('/ess/leave-requests', authenticate, async (req, res) => {
  const employee = await Employee.findOne({ user_id: req.user._id });
  if (!employee) return res.json({ success: true, data: [] });
  const data = await LeaveRequest.find({ employee_id: employee._id }).sort({ createdAt: -1 });
  res.json({ success: true, data });
});
router.post('/ess/leave-requests', authenticate, async (req, res) => {
  const { leave_type, start_date, end_date, reason } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ success: false, message: 'start_date and end_date required.' });
  const employee = await Employee.findOne({ user_id: req.user._id });
  if (!employee) return res.status(404).json({ success: false, message: 'Employee record not found for your account.' });
  const data = await LeaveRequest.create({ employee_id: employee._id, leave_type: leave_type || 'annual', start_date, end_date, reason });
  res.status(201).json({ success: true, data });
});
router.get('/ess/payslips', authenticate, async (req, res) => {
  const employee = await Employee.findOne({ user_id: req.user._id });
  if (!employee) return res.json({ success: true, data: [] });
  const data = await PayrollRun.find({ employee_id: employee._id }).sort({ year: -1, month: -1 });
  res.json({ success: true, data });
});

// DEPARTMENTS
router.get('/departments', authenticate, requireTenant, async (req, res) => {
  const data = await Department.find({ tenant_id: req.tenant_id }).sort('name');
  res.json({ success: true, data });
});
router.post('/departments', authenticate, requireTenant, authorize('business_owner', 'hr_manager'), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'name required.' });
  const data = await Department.create({ tenant_id: req.tenant_id, name, description });
  res.status(201).json({ success: true, data });
});
router.put('/departments/:id', authenticate, requireTenant, authorize('business_owner', 'hr_manager'), async (req, res) => {
  const { name, description } = req.body;
  const data = await Department.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { name, description }, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Department not found.' });
  res.json({ success: true, data });
});

// EMPLOYEES
router.get('/employees', authenticate, requireTenant, async (req, res) => {
  const data = await Employee.find({ tenant_id: req.tenant_id }).populate('department_id', 'name').sort('name');
  const mapped = data.map(e => ({ ...e.toJSON(), department_name: e.department_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/employees', authenticate, requireTenant, authorize('business_owner', 'hr_manager'), async (req, res) => {
  const { name, email, phone, department_id, job_title, gross_salary, start_date, employee_code,
    photo, date_of_birth, gender, nationality, marital_status, national_id, address, employment_type,
    emergency_name, emergency_phone, emergency_relation } = req.body;
  if (!name || !gross_salary) return res.status(400).json({ success: false, message: 'name and gross_salary required.' });
  const code = employee_code || `EMP-${Date.now().toString().slice(-6)}`;
  const data = await Employee.create({
    tenant_id: req.tenant_id, employee_code: code, name, email, phone,
    department_id: department_id || null, job_title, gross_salary, start_date: start_date || null,
    photo, date_of_birth: date_of_birth || null, gender, nationality, marital_status,
    national_id, address, employment_type: employment_type || 'full_time',
    emergency_name, emergency_phone, emergency_relation,
  });
  res.status(201).json({ success: true, data });
});

router.put('/employees/:id', authenticate, requireTenant, authorize('business_owner', 'hr_manager'), async (req, res) => {
  const allowed = ['name','email','phone','department_id','job_title','gross_salary','start_date','status',
    'photo','date_of_birth','gender','nationality','marital_status','national_id','address','employment_type',
    'emergency_name','emergency_phone','emergency_relation'];
  const update = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
  const data = await Employee.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, update, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Employee not found.' });
  res.json({ success: true, data });
});

router.post('/employees/:id/documents', authenticate, requireTenant, authorize('business_owner', 'hr_manager'), async (req, res) => {
  const { name, type, file, mime_type } = req.body;
  if (!name || !file) return res.status(400).json({ success: false, message: 'name and file required.' });
  const emp = await Employee.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });
  emp.documents.push({ name, type: type || 'other', file, mime_type, uploaded_at: new Date() });
  await emp.save();
  res.json({ success: true, data: emp.documents });
});

router.delete('/employees/:id/documents/:docId', authenticate, requireTenant, authorize('business_owner', 'hr_manager'), async (req, res) => {
  const emp = await Employee.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });
  emp.documents = emp.documents.filter(d => String(d._id) !== req.params.docId);
  await emp.save();
  res.json({ success: true, message: 'Document deleted.' });
});

// ATTENDANCE
router.get('/attendance', authenticate, requireTenant, async (req, res) => {
  const filter = { tenant_id: req.tenant_id };
  if (req.query.date) filter.date = new Date(req.query.date);
  const data = await Attendance.find(filter).populate('employee_id', 'name').sort('employee_id');
  const mapped = data.map(a => ({ ...a.toJSON(), employee_name: a.employee_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/attendance', authenticate, requireTenant, authorize('business_owner', 'hr_manager'), async (req, res) => {
  const { employee_id, date, status, notes } = req.body;
  if (!employee_id || !date) return res.status(400).json({ success: false, message: 'employee_id and date required.' });
  const data = await Attendance.findOneAndUpdate(
    { tenant_id: req.tenant_id, employee_id, date: new Date(date) },
    { status: status || 'present', notes },
    { upsert: true, new: true }
  );
  res.status(201).json({ success: true, data });
});

// LEAVE REQUESTS
router.get('/leave-requests', authenticate, requireTenant, async (req, res) => {
  const data = await LeaveRequest.find({ tenant_id: req.tenant_id }).populate('employee_id', 'name').sort({ createdAt: -1 });
  const mapped = data.map(l => ({ ...l.toJSON(), employee_name: l.employee_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/leave-requests', authenticate, requireTenant, authorize('business_owner', 'hr_manager'), async (req, res) => {
  const { employee_id, leave_type, start_date, end_date, reason } = req.body;
  if (!employee_id || !start_date || !end_date) return res.status(400).json({ success: false, message: 'employee_id, start_date and end_date required.' });
  const data = await LeaveRequest.create({ tenant_id: req.tenant_id, employee_id, leave_type: leave_type || 'annual', start_date, end_date, reason });
  res.status(201).json({ success: true, data });
});
router.patch('/leave-requests/:id', authenticate, requireTenant, authorize('business_owner', 'hr_manager'), async (req, res) => {
  const data = await LeaveRequest.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { status: req.body.status, reviewed_by: req.user._id }, { new: true });
  res.json({ success: true, data });
});

// PAYROLL
router.get('/payroll', authenticate, requireTenant, async (req, res) => {
  const data = await PayrollRun.find({ tenant_id: req.tenant_id }).populate('employee_id', 'name').sort({ year: -1, month: -1 });
  const mapped = data.map(p => ({ ...p.toJSON(), employee_name: p.employee_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/payroll', authenticate, requireTenant, authorize('business_owner', 'hr_manager'), async (req, res) => {
  const { employee_id, month, year, allowances, deductions } = req.body;
  if (!employee_id) return res.status(400).json({ success: false, message: 'employee_id required.' });
  const emp = await Employee.findOne({ _id: employee_id, tenant_id: req.tenant_id });
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });
  const gross = emp.gross_salary;
  const net = gross + parseFloat(allowances || 0) - parseFloat(deductions || 0);
  const data = await PayrollRun.create({ tenant_id: req.tenant_id, employee_id, month, year, gross_salary: gross, allowances: allowances || 0, deductions: deductions || 0, net_salary: net });
  res.status(201).json({ success: true, data });
});
router.patch('/payroll/:id/approve', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const data = await PayrollRun.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { status: 'approved', approved_by: req.user._id }, { new: true });
  if (data) {
    const emp = await Employee.findById(data.employee_id).select('name');
    const ref = `${emp?.name || data.employee_id}-${data.month}-${data.year}`;
    await logPayment({ tenant_id: req.tenant_id, source: 'payroll', reference: `PAYROLL-${ref}`, amount: data.net_salary, method: 'bank_transfer', status: 'success', payer_name: emp?.name, description: `Payroll approved for ${emp?.name || data.employee_id} — ${data.month}/${data.year}`, source_id: data._id, recorded_by: req.user._id });
    await accounting.postPayrollEntry({ tenantId: req.tenant_id, amount: data.net_salary, reference: ref, date: new Date(), sourceId: data._id, createdBy: req.user._id }).catch(() => {});
  }
  res.json({ success: true, data });
});

// CRM - CUSTOMERS
router.get('/customers', authenticate, requireTenant, async (req, res) => {
  const data = await Customer.find({ tenant_id: req.tenant_id }).sort({ createdAt: -1 });
  res.json({ success: true, data });
});
router.post('/customers', authenticate, requireTenant, authorize('business_owner', 'sales_staff'), async (req, res) => {
  const { name, email, phone, company, address, segment, notes } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'name required.' });
  const data = await Customer.create({ tenant_id: req.tenant_id, name, email, phone, company, address, segment: segment || 'general', notes, created_by: req.user._id });
  res.status(201).json({ success: true, data });
});

// CRM - LEADS
router.get('/leads', authenticate, requireTenant, async (req, res) => {
  const data = await Lead.find({ tenant_id: req.tenant_id }).populate('customer_id', 'name').populate('assigned_to', 'name').sort({ createdAt: -1 });
  const mapped = data.map(l => ({ ...l.toJSON(), customer_name: l.customer_id?.name || null, assigned_to_name: l.assigned_to?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/leads', authenticate, requireTenant, authorize('business_owner', 'sales_staff'), async (req, res) => {
  const { customer_id, title, stage, value, assigned_to, notes, next_followup } = req.body;
  if (!title) return res.status(400).json({ success: false, message: 'title required.' });
  const data = await Lead.create({ tenant_id: req.tenant_id, customer_id: customer_id || null, title, stage: stage || 'new', value: value || 0, assigned_to: assigned_to || null, notes, next_followup: next_followup || null });
  res.status(201).json({ success: true, data });
});
router.patch('/leads/:id', authenticate, requireTenant, async (req, res) => {
  const { stage, value, notes, next_followup } = req.body;
  const update = {};
  if (stage !== undefined) update.stage = stage;
  if (value !== undefined) update.value = value;
  if (notes !== undefined) update.notes = notes;
  if (next_followup !== undefined) update.next_followup = next_followup;
  const data = await Lead.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, update, { new: true });
  res.json({ success: true, data });
});

// CRM - CONTACT HISTORY
router.get('/contact-history', authenticate, requireTenant, async (req, res) => {
  const data = await ContactHistory.find({ tenant_id: req.tenant_id }).populate('customer_id', 'name').sort({ contact_date: -1, createdAt: -1 });
  const mapped = data.map(c => ({ ...c.toJSON(), customer_name: c.customer_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/contact-history', authenticate, requireTenant, authorize('business_owner', 'sales_staff'), async (req, res) => {
  const { customer_id, type, notes, contact_date } = req.body;
  const data = await ContactHistory.create({ tenant_id: req.tenant_id, customer_id: customer_id || null, type: type || 'call', notes, contact_date: contact_date || Date.now(), created_by: req.user._id });
  res.status(201).json({ success: true, data });
});

// REPORTS
router.get('/reports/sales', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const match = { tenant_id: tid, payment_status: 'paid' };
  if (req.query.from || req.query.to) {
    match.createdAt = {};
    if (req.query.from) match.createdAt.$gte = new Date(req.query.from);
    if (req.query.to)   match.createdAt.$lte = new Date(req.query.to);
  }
  const [summary, monthly, topProducts, byStatus] = await Promise.all([
    Order.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 }, avg: { $avg: '$total' } } }]),
    Order.aggregate([
      { $match: { tenant_id: tid, payment_status: 'paid', createdAt: { $gte: new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000) } } },
      { $group: { _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      { $project: { month: { $arrayElemAt: [['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], '$_id.month'] }, revenue: 1, orders: 1 } },
    ]),
    Order.aggregate([
      { $match: match }, { $unwind: '$items' },
      { $group: { _id: '$items.product_id', name: { $first: '$items.product_name' }, units_sold: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' } } },
      { $sort: { revenue: -1 } }, { $limit: 6 },
    ]),
    Order.aggregate([{ $match: { tenant_id: tid } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const by_status = {};
  byStatus.forEach(r => { by_status[r._id] = r.count; });
  const s = summary[0] || {};
  res.json({ success: true, data: { total_revenue: s.total || 0, total_orders: s.count || 0, avg_order_value: s.avg || 0, paid_orders: s.count || 0, monthly, top_products: topProducts, by_status } });
});

router.get('/reports/inventory', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const [products, valueAgg, lowStock, byCat] = await Promise.all([
    Product.find({ tenant_id: tid, is_active: true }),
    Product.aggregate([{ $match: { tenant_id: tid, is_active: true } }, { $group: { _id: null, total: { $sum: { $multiply: ['$cost_price', '$stock_qty'] } } } }]),
    Product.find({ tenant_id: tid, is_active: true, $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] } }).sort('stock_qty').limit(10),
    Product.aggregate([
      { $match: { tenant_id: tid, is_active: true } },
      { $lookup: { from: 'categories', localField: 'category_id', foreignField: '_id', as: 'cat' } },
      { $group: { _id: { $arrayElemAt: ['$cat.name', 0] }, value: { $sum: { $multiply: ['$cost_price', '$stock_qty'] } } } },
      { $sort: { value: -1 } },
    ]),
  ]);
  res.json({ success: true, data: {
    total_products: products.length,
    out_of_stock: products.filter(p => p.stock_qty === 0).length,
    low_stock_count: products.filter(p => p.stock_qty <= p.low_stock_threshold && p.stock_qty > 0).length,
    total_value: valueAgg[0]?.total || 0,
    low_stock: lowStock,
    by_category: byCat.map(c => ({ category: c._id, value: c.value })),
  }});
});

router.get('/reports/finance', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const [rev, exp, bycat] = await Promise.all([
    Order.aggregate([{ $match: { tenant_id: tid, payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Expense.aggregate([{ $match: { tenant_id: tid } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Expense.aggregate([{ $match: { tenant_id: tid } }, { $group: { _id: { $ifNull: ['$category', 'Uncategorized'] }, total: { $sum: '$amount' } } }, { $sort: { total: -1 } }]),
  ]);
  res.json({ success: true, data: { revenue: rev[0]?.total || 0, total_expenses: exp[0]?.total || 0, expenses_by_category: bycat.map(c => ({ category: c._id, total: c.total })) } });
});

router.get('/reports/hr', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const now = new Date();
  const today = new Date(); today.setHours(0,0,0,0);
  const [employees, payroll, byDept, onLeave] = await Promise.all([
    Employee.find({ tenant_id: tid }),
    PayrollRun.aggregate([{ $match: { tenant_id: tid, month: now.getMonth() + 1, year: now.getFullYear(), status: 'approved' } }, { $group: { _id: null, total: { $sum: '$net_salary' } } }]),
    Employee.aggregate([
      { $match: { tenant_id: tid, status: 'active' } },
      { $lookup: { from: 'departments', localField: 'department_id', foreignField: '_id', as: 'dept' } },
      { $group: { _id: { $arrayElemAt: ['$dept.name', 0] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    LeaveRequest.countDocuments({ tenant_id: tid, status: 'approved', start_date: { $lte: today }, end_date: { $gte: today } }),
  ]);
  res.json({ success: true, data: {
    total_employees: employees.length,
    active: employees.filter(e => e.status === 'active').length,
    on_leave: onLeave,
    monthly_payroll: payroll[0]?.total || 0,
    by_department: byDept.map(d => ({ department: d._id, count: d.count })),
  }});
});

router.get('/reports/procurement', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const [pos, spend, bySupplier, recent] = await Promise.all([
    PurchaseOrder.find({ tenant_id: tid }),
    PurchaseOrder.aggregate([{ $match: { tenant_id: tid } }, { $group: { _id: null, total: { $sum: '$total_cost' } } }]),
    PurchaseOrder.aggregate([
      { $match: { tenant_id: tid } },
      { $lookup: { from: 'suppliers', localField: 'supplier_id', foreignField: '_id', as: 'sup' } },
      { $group: { _id: { $arrayElemAt: ['$sup.name', 0] }, total: { $sum: '$total_cost' } } },
      { $sort: { total: -1 } }, { $limit: 8 },
    ]),
    PurchaseOrder.find({ tenant_id: tid }).populate('supplier_id', 'name').sort({ createdAt: -1 }).limit(10),
  ]);
  res.json({ success: true, data: {
    total_pos: pos.length,
    completed_pos: pos.filter(p => p.status === 'completed').length,
    pending_delivery: pos.filter(p => ['approved', 'sent', 'partially_received'].includes(p.status)).length,
    total_spend: spend[0]?.total || 0,
    by_supplier: bySupplier.map(s => ({ supplier: s._id, total: s.total })),
    recent_pos: recent,
  }});
});

router.get('/reports/crm', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const [customers, leads, byStage, topCust] = await Promise.all([
    Customer.countDocuments({ tenant_id: tid }),
    Lead.aggregate([{ $match: { tenant_id: tid } }, { $group: { _id: null, active: { $sum: { $cond: [{ $not: [{ $in: ['$stage', ['won', 'lost']] }] }, 1, 0] } }, won: { $sum: { $cond: [{ $eq: ['$stage', 'won'] }, 1, 0] } }, pipeline: { $sum: { $cond: [{ $not: [{ $in: ['$stage', ['won', 'lost']] }] }, '$value', 0] } } } }]),
    Lead.aggregate([{ $match: { tenant_id: tid } }, { $group: { _id: '$stage', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Customer.aggregate([
      { $match: { tenant_id: tid } },
      { $lookup: { from: 'orders', localField: '_id', foreignField: 'customer_id', as: 'orders' } },
      { $addFields: { order_count: { $size: '$orders' } } },
      { $sort: { order_count: -1 } }, { $limit: 10 }, { $project: { orders: 0 } },
    ]),
  ]);
  const l = leads[0] || {};
  res.json({ success: true, data: { total_customers: customers, active_leads: l.active || 0, won_leads: l.won || 0, pipeline_value: l.pipeline || 0, by_stage: byStage.map(s => ({ stage: s._id, count: s.count })), top_customers: topCust } });
});

// ── ACCOUNTING MODULE ────────────────────────────────────────────────────────
// All accounting routes live in routes/accounting.js
// This is the standalone boundary — this router can be extracted independently
router.use('/', accountingRouter);

// CHAT
const chat = require('../controllers/chatController');
router.get('/chat/conversation',                  authenticate, requireTenant, chat.getOrCreateConversation);
router.get('/chat/messages/:conversationId',      authenticate, chat.getMessages);
router.post('/chat/messages',                     authenticate, chat.sendMessage);
router.get('/chat/admin/conversations',           authenticate, platformAdminOnly, chat.getAllConversations);
router.patch('/chat/conversations/:id/resolve',   authenticate, platformAdminOnly, chat.resolveConversation);

module.exports = router;
