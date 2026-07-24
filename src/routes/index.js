const express = require('express');
const router = express.Router();
const { authenticate, authorize, superAdminOnly, platformAdminOnly, businessOwnerOnly, requireTenant, authenticateStoreCustomer } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureFlags');
const { productModeGate } = require('../middleware/productMode');
const { requireModule } = require('../middleware/moduleAccess');
const { resolveWriteBranchId } = require('../middleware/branchScope');
const { getModeMeta } = require('../config/productMode');
const storefrontDocsRouter = require('./storefrontDocs');
const auth = require('../controllers/authController');
const users = require('../controllers/usersController');
const dashboard = require('../controllers/dashboardController');
const inventory = require('../controllers/inventoryController');
const hr = require('../controllers/hrController');
const upload = require('../controllers/uploadController');
const { imageUpload, hrDocUpload } = require('../middleware/uploadMiddleware');
const orders = require('../controllers/ordersController');
const procurement = require('../controllers/procurementController');
const storefront = require('../controllers/storefrontController');
const payout = require('../controllers/payoutController');
const tenant = require('../controllers/tenantController');
const branch = require('../controllers/branchController');
const logPayment = require('../utils/paymentLog');
const accounting = require('../services/accountingService');
const pos = require('../controllers/posController');
const storeCustomer = require('../controllers/storeCustomerController');
const { validateCoupon } = require('../services/couponService');
const { completePosSale, getOpenShift, requireOpenShift, recordShiftRefund } = require('../services/posService');
const accountingRouter = require('./accounting');
const reportsRouter = require('./reports');
const {
  Supplier, PurchaseOrder, Product, StockMovement,
  Account, Expense, JournalEntry,
  Department, Employee, Attendance, LeaveRequest, PayrollRun,
  Customer, Lead, ContactHistory, Order, Coupon,
} = require('../models');

// AUTH
router.post('/auth/login', auth.login);
router.get('/auth/me', authenticate, auth.getMe);
router.post('/auth/change-password', authenticate, auth.changePassword);
router.post('/auth/forgot-password', auth.forgotPassword);
router.post('/auth/reset-password', auth.resetPassword);

// TENANT REGISTRATION (public)
router.post('/tenants/register', tenant.registerTenant);

// Product mode info + storefront API docs (public)
router.get('/product-info', (req, res) => res.json({ success: true, data: getModeMeta() }));
router.use(storefrontDocsRouter);

// Restrict API surface when PRODUCT_MODE=pos|storefront|accounting
router.use(productModeGate);

// Audit logging is resolved inside the `authenticate` middleware — it must run
// after auth (needs req.user), and per-route authenticate runs after any
// router.use() here, so a router-level middleware would see no req.user.

// Branch scoping (req.branchFilter) is resolved inside the `authenticate`
// middleware — it must run after auth, and per-route authenticate runs after
// any router.use() here, so a router-level middleware would see no req.user.

// PLATFORM ADMIN â€” tenant management (us only)
router.get('/platform/tenants', authenticate, platformAdminOnly, tenant.getAllTenants);
router.get('/platform/tenants/:id', authenticate, platformAdminOnly, tenant.getTenant);
router.patch('/platform/tenants/:id', authenticate, platformAdminOnly, tenant.updateTenant);
router.patch('/platform/tenants/:id/suspend', authenticate, platformAdminOnly, tenant.suspendTenant);
router.patch('/platform/tenants/:id/activate', authenticate, platformAdminOnly, tenant.activateTenant);

// MY TENANT â€” business owner sees their own tenant
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

// â”€â”€ CUSTOM ROLES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const { Role } = require('../models');

router.get('/roles', authenticate, requireTenant, businessOwnerOnly, async (req, res) => {
  const roles = await Role.find({ tenant_id: req.tenant_id }).sort({ name: 1 });
  res.json({ success: true, data: roles });
});

router.post('/roles', authenticate, requireTenant, businessOwnerOnly, async (req, res) => {
  const { name, permissions } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Role name is required.' });
  const exists = await Role.findOne({ tenant_id: req.tenant_id, name: name.trim() });
  if (exists) return res.status(400).json({ success: false, message: 'A role with this name already exists.' });
  const role = await Role.create({ tenant_id: req.tenant_id, name: name.trim(), permissions: permissions || [] });
  res.json({ success: true, data: role });
});

router.put('/roles/:id', authenticate, requireTenant, businessOwnerOnly, async (req, res) => {
  const { name, permissions, is_active } = req.body;
  const role = await Role.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    { ...(name && { name: name.trim() }), ...(permissions !== undefined && { permissions }), ...(is_active !== undefined && { is_active }) },
    { new: true }
  );
  if (!role) return res.status(404).json({ success: false, message: 'Role not found.' });
  res.json({ success: true, data: role });
});

router.delete('/roles/:id', authenticate, requireTenant, businessOwnerOnly, async (req, res) => {
  const { User } = require('../models');
  const inUse = await User.countDocuments({ tenant_id: req.tenant_id, custom_role_id: req.params.id });
  if (inUse > 0) return res.status(400).json({ success: false, message: `Cannot delete â€” ${inUse} user(s) are assigned this role.` });
  await Role.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant_id });
  res.json({ success: true });
});

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

// GET /billing/callback?reference=xxx â€” called by frontend after Paystack card redirect
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
  if (data.paystack_secret_key) data.paystack_secret_key = 'â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢' + data.paystack_secret_key.slice(-4);
  res.json({ success: true, data });
});
router.put('/platform/settings', authenticate, platformAdminOnly, async (req, res) => {
  const { PlatformSettings } = require('../models');
  const {
    trial_days, grace_days, plans, currency, auto_renew_default,
    platform_name, support_email, platform_logo,
    paystack_public_key, paystack_secret_key, paystack_webhook_url,
    paystack_virtual_terminal_code, paystack_terminal_whatsapp,
    trial_warning_days, expiry_alert_days,
    audit_retention_days, feature_flags,
  } = req.body;
  let settings = await PlatformSettings.findOne();
  if (!settings) settings = new PlatformSettings();
  const fields = {
    trial_days, grace_days, currency, auto_renew_default,
    platform_name, support_email, platform_logo,
    paystack_public_key, paystack_webhook_url,
    paystack_virtual_terminal_code, paystack_terminal_whatsapp,
    trial_warning_days, expiry_alert_days, audit_retention_days,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) settings[k] = v;
  }
  // Only update secret key if a real value (not masked) is provided
  if (paystack_secret_key && !paystack_secret_key.startsWith('â€¢â€¢â€¢â€¢')) {
    settings.paystack_secret_key = paystack_secret_key;
  }
  if (plans !== undefined) { settings.plans = plans; settings.markModified('plans'); }
  if (feature_flags !== undefined) { settings.feature_flags = feature_flags; settings.markModified('feature_flags'); }
  await settings.save();
  const { invalidatePlatformSettingsCache } = require('../services/tenantService');
  const { invalidatePaystackCredentialsCache } = require('../services/paymentService');
  invalidatePlatformSettingsCache();
  invalidatePaystackCredentialsCache();
  const data = settings.toJSON();
  if (data.paystack_secret_key) data.paystack_secret_key = 'â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢' + data.paystack_secret_key.slice(-4);
  res.json({ success: true, data });
});

// Public plan prices â€” used by billing page (no auth required)
router.get('/plan-prices', async (req, res) => {
  const { PlatformSettings } = require('../models');
  const settings = await PlatformSettings.findOne();
  const plans = settings?.plans || {
    starter:    { price: 350,  max_branches: 1,   max_users: 5   },
    pro:        { price: 850,  max_branches: 5,   max_users: 20  },
    enterprise: { price: 2000, max_branches: 999, max_users: 999 },
  };
  res.json({ success: true, data: { plans } });
});

router.get('/billing/module-prices', billing.getModulePrices);

// AUDIT LOGS
router.get('/audit-logs', authenticate, async (req, res) => {
  const { AuditLog, Branch } = require('../models');
  const { module: mod, action, user_id, branch_id, from, to, page = 1, limit = 50 } = req.query;
  const filter = {};

  // Platform admin sees all, tenant users see only their tenant
  if (req.user.role !== 'platform_admin') filter.tenant_id = req.tenant_id;

  if (mod)       filter.module    = mod;
  if (action)    filter.action    = new RegExp(action, 'i');
  if (user_id)   filter.user_id   = user_id;
  if (branch_id) filter.branch_id = branch_id;
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(from);
    if (to)   filter.createdAt.$lte = new Date(to + 'T23:59:59');
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [logs, total, branches] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
    AuditLog.countDocuments(filter),
    Branch.find(
      req.user.role === 'platform_admin' ? { is_active: true } : { tenant_id: req.tenant_id, is_active: true }
    ).select('_id name').lean(),
  ]);

  const branchMap = Object.fromEntries(branches.map(b => [String(b._id), b.name]));
  const data = logs.map(l => ({
    ...l,
    id: l._id,
    branch_name: l.branch_id ? (branchMap[String(l.branch_id)] || 'Unknown') : null,
  }));

  res.json({ success: true, data, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), branches });
});

// DASHBOARD
router.get('/dashboard', authenticate, requireTenant, dashboard.getDashboard);

// INVENTORY
// Allow public access when tenant_slug query param is present (storefront)
router.get('/categories', (req, res, next) => {
  if (req.query.tenant_slug) return next();
  authenticate(req, res, () => requireTenant(req, res, next));
}, inventory.getCategories);
router.post('/categories', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), async (req, res) => {
  const { name, description, custom_fields } = req.body;
  const { Category } = require('../models');
  const data = await Category.create({ tenant_id: req.tenant_id, name, description, custom_fields: custom_fields || [] });
  res.status(201).json({ success: true, data });
});
router.put('/categories/:id', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), async (req, res) => {
  const { name, description, custom_fields } = req.body;
  const { Category } = require('../models');
  const data = await Category.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    { name, description, ...(custom_fields !== undefined && { custom_fields }) },
    { new: true }
  );
  if (!data) return res.status(404).json({ success: false, message: 'Category not found.' });
  res.json({ success: true, data });
});
router.delete('/categories/:id', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), inventory.deleteCategory);
router.get('/products', authenticate, requireTenant, inventory.getProducts);
router.get('/products/:id', authenticate, requireTenant, inventory.getProduct);
router.post('/products', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), inventory.createProduct);
router.put('/products/:id', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), inventory.updateProduct);
router.delete('/products/:id', authenticate, requireTenant, businessOwnerOnly, inventory.deleteProduct);
router.post('/products/:id/adjust-stock', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), inventory.adjustStock);
router.get('/products/:id/movements', authenticate, requireTenant, inventory.getStockMovements);
router.post(
  '/uploads/product-images',
  authenticate,
  requireTenant,
  authorize('business_owner', 'branch_manager', 'warehouse_staff'),
  imageUpload.array('images', 8),
  upload.uploadProductImages,
);

// POS
router.post('/pos/sale', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), async (req, res) => {
  const { items, payment_method, amount_tendered, customer_name, customer_phone, payment_ref } = req.body;
  if (!items?.length) return res.status(400).json({ success: false, message: 'items required.' });
  if (payment_method === 'momo' || payment_method === 'card' || payment_method === 'card_terminal') {
    return res.status(400).json({ success: false, message: 'Use Paystack flow for QR card, virtual terminal, and mobile money payments.' });
  }
  try {
    const saleBranchId = await resolveWriteBranchId(req);
    const shift = await requireOpenShift(req.tenant_id, req.user._id, saleBranchId);
    const result = await completePosSale({
      tenantId: req.tenant_id,
      userId: req.user._id,
      branchId: saleBranchId,
      items,
      payment_method: payment_method || 'cash',
      payment_ref: payment_ref || null,
      customer_name,
      customer_phone,
      shift_id: shift._id,
      amount_tendered,
    });
    res.status(201).json({ success: true, data: { ...result.order.toJSON(), amount_tendered: result.amount_tendered, change: result.change } });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message || 'Sale failed.' });
  }
});

router.post('/pos/paystack/init', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), pos.initPaystackPayment);
router.post('/pos/paystack/verify', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), pos.verifyPaystackPayment);
router.get('/pos/paystack/pending', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), pos.getPendingPaystackOrders);
router.post('/pos/paystack/cancel', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), pos.cancelPaystackPending);
router.get('/pos/paystack/terminal', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), pos.getVirtualTerminalInfo);
router.get('/pos/display/current', authenticate, requireTenant, requireFeature('pos'), pos.getCustomerDisplaySession);
router.get('/pos/display/queue', authenticate, requireTenant, requireFeature('pos'), pos.getDisplayQueueSession);
router.post('/pos/display/show', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), pos.publishDisplayOrder);
router.post('/pos/display/clear', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), pos.clearDisplaySession);
router.post('/pos/shifts/open', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), pos.openShift);
router.get('/pos/shifts/current', authenticate, requireTenant, requireFeature('pos'), pos.getCurrentShift);
router.get('/pos/shifts', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), pos.listShiftHistory);
router.post('/pos/shifts/close', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), pos.closeShift);
router.get('/pos/shifts/:id/z-report', authenticate, requireTenant, requireFeature('pos'), pos.getZReport);
router.get('/pos/shifts/:id', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), pos.getShiftHistoryDetail);

router.post('/pos/refund', authenticate, requireTenant, requireFeature('pos'), authorize('business_owner', 'sales_staff', 'branch_manager'), async (req, res) => {
  const { order_number, items, reason } = req.body;
  if (!order_number) return res.status(400).json({ success: false, message: 'order_number required.' });

  try {
    await requireOpenShift(req.tenant_id, req.user._id, await resolveWriteBranchId(req));
  } catch (err) {
    return res.status(err.status || 403).json({ success: false, message: err.message });
  }

  const order = await Order.findOne({ tenant_id: req.tenant_id, order_number, source: 'pos', payment_status: 'paid' });
  if (!order) return res.status(404).json({ success: false, message: 'POS sale not found or already refunded.' });

  const refundLines = items?.length
    ? items
    : order.items.map((i) => ({ product_id: String(i.product_id), quantity: i.quantity - (i.refunded_qty || 0) })).filter((i) => i.quantity > 0);

  if (!refundLines.length) return res.status(400).json({ success: false, message: 'Nothing left to refund on this sale.' });

  let refundSubtotal = 0;
  let refundCogs = 0;
  const refundedItems = [];

  for (const line of refundLines) {
    const orderItem = order.items.find((i) => String(i.product_id) === String(line.product_id));
    if (!orderItem) return res.status(400).json({ success: false, message: `Product not on original sale.` });
    const remaining = orderItem.quantity - (orderItem.refunded_qty || 0);
    const qty = Math.min(parseInt(line.quantity, 10) || 0, remaining);
    if (qty <= 0) continue;

    const p = await Product.findOne({ _id: orderItem.product_id, tenant_id: req.tenant_id });
    if (!p) return res.status(400).json({ success: false, message: 'Product not found.' });

    const lineTotal = orderItem.unit_price * qty;
    const lineCogs = (p.cost_price || 0) * qty;
    refundSubtotal += lineTotal;
    refundCogs += lineCogs;
    orderItem.refunded_qty = (orderItem.refunded_qty || 0) + qty;
    refundedItems.push({ product_id: p._id, product_name: orderItem.product_name, quantity: qty, amount: lineTotal });

    await Product.findByIdAndUpdate(p._id, { $inc: { stock_qty: qty } });
    await StockMovement.create({
      tenant_id: req.tenant_id,
      branch_id: order.branch_id || null,
      product_id: p._id,
      type: 'return',
      quantity: qty,
      reference: `REF-${order.order_number}`,
      notes: reason || 'POS refund',
      created_by: req.user._id,
    });
  }

  if (!refundedItems.length) return res.status(400).json({ success: false, message: 'Invalid refund quantities.' });

  order.refund_amount = (order.refund_amount || 0) + refundSubtotal;
  const fullyRefunded = order.items.every((i) => (i.refunded_qty || 0) >= i.quantity);
  if (fullyRefunded) order.payment_status = 'refunded';
  order.markModified('items');
  await order.save();

  const refundRef = `REF-${order.order_number}-${Date.now()}`;
  await logPayment({
    tenant_id: req.tenant_id,
    source: 'pos',
    reference: refundRef,
    amount: -refundSubtotal,
    method: order.payment_method || 'cash',
    status: 'success',
    payer_name: order.customer_name,
    description: `POS refund for ${order.order_number}${reason ? `: ${reason}` : ''}`,
    source_id: order._id,
    recorded_by: req.user._id,
  });

  await accounting.postSaleReturnEntry({
    tenantId: req.tenant_id,
    amount: refundSubtotal,
    cogsAmount: refundCogs,
    taxAmount: 0,
    reference: refundRef,
    date: new Date(),
    sourceId: order._id,
    createdBy: req.user._id,
  }).catch((err) => console.error('[POS] Refund GL failed:', err.message));

  await recordShiftRefund(order.shift_id, refundSubtotal, order.payment_method);

  res.json({
    success: true,
    message: fullyRefunded ? 'Sale fully refunded.' : 'Partial refund processed.',
    data: { order_number: order.order_number, refund_amount: refundSubtotal, refunded_items: refundedItems, payment_status: order.payment_status },
  });
});

router.get('/pos/products', authenticate, requireTenant, requireFeature('pos'), async (req, res) => {
  const { search, category } = req.query;
  const filter = { tenant_id: req.tenant_id, ...(req.branchFilter || {}), is_active: true };
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { sku: new RegExp(search, 'i') }];
  if (category) {
    const { Category } = require('../models');
    const cat = await Category.findOne({ tenant_id: req.tenant_id, name: category });
    if (cat) filter.category_id = cat._id;
  }
  const products = await Product.find(filter).populate('category_id', 'name').sort('name').limit(200);
  const data = products.map((p) => {
    const physical = p.stock_qty || 0;
    const reserved = p.reserved_qty || 0;
    const available = Math.max(0, physical - reserved);
    return {
      ...p.toObject(),
      id: p._id,
      category_name: p.category_id?.name || 'General',
      barcode: p.barcode || null,
      stock_qty: available,
    };
  });
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
router.get('/storefront/settings', authenticate, requireTenant, requireFeature('storefront'), storefront.getMerchantSettings);
router.put('/storefront/settings', authenticate, requireTenant, requireFeature('storefront'), storefront.updateMerchantSettings);

// Payout methods
router.get('/payout-methods', authenticate, requireTenant, businessOwnerOnly, payout.list);
router.post('/payout-methods', authenticate, requireTenant, businessOwnerOnly, payout.create);
router.patch('/payout-methods/:id/default', authenticate, requireTenant, businessOwnerOnly, payout.setDefault);
router.delete('/payout-methods/:id', authenticate, requireTenant, businessOwnerOnly, payout.remove);
router.get('/storefront/resolve-domain', storefront.resolveDomain);
router.post('/storefront/:tenantSlug/customers/register', storeCustomer.register);
router.post('/storefront/:tenantSlug/customers/login', storeCustomer.login);
router.post('/storefront/:tenantSlug/customers/google', storeCustomer.googleAuth);
router.get('/storefront/customer/me', authenticateStoreCustomer, storeCustomer.getMe);
router.get('/storefront/customer/orders', authenticateStoreCustomer, storeCustomer.getMyOrders);
router.post('/storefront/coupons/validate', async (req, res) => {
  const { code, subtotal, tenant_id, tenant_slug } = req.body;
  if (!code) return res.status(400).json({ success: false, message: 'code required.' });
  let tid = tenant_id;
  if (!tid && tenant_slug) {
    const { Tenant } = require('../models');
    const t = await Tenant.findOne({ slug: tenant_slug, is_active: true });
    if (!t) return res.status(404).json({ success: false, message: 'Store not found.' });
    tid = t._id;
  }
  if (!tid) return res.status(400).json({ success: false, message: 'tenant_id or tenant_slug required.' });
  const result = await validateCoupon({ tenantId: tid, code, subtotal: parseFloat(subtotal) || 0 });
  if (!result.valid) return res.status(400).json({ success: false, message: result.message });
  res.json({ success: true, data: { code: result.code, discount: result.discount, discount_type: result.discount_type, discount_value: result.discount_value } });
});

router.get('/coupons', authenticate, requireTenant, requireFeature('storefront'), async (req, res) => {
  const data = await Coupon.find({ tenant_id: req.tenant_id }).sort({ createdAt: -1 });
  res.json({ success: true, data });
});
router.post('/coupons', authenticate, requireTenant, requireFeature('storefront'), businessOwnerOnly, async (req, res) => {
  const { code, discount_type, discount_value, min_order_amount, max_uses, expires_at } = req.body;
  if (!code || discount_value === undefined) return res.status(400).json({ success: false, message: 'code and discount_value required.' });
  const data = await Coupon.create({
    tenant_id: req.tenant_id,
    code: String(code).toUpperCase().trim(),
    discount_type: discount_type || 'percent',
    discount_value: parseFloat(discount_value),
    min_order_amount: parseFloat(min_order_amount) || 0,
    max_uses: parseInt(max_uses, 10) || 0,
    expires_at: expires_at ? new Date(expires_at) : null,
  });
  res.status(201).json({ success: true, data });
});
router.delete('/coupons/:id', authenticate, requireTenant, requireFeature('storefront'), businessOwnerOnly, async (req, res) => {
  await Coupon.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant_id });
  res.json({ success: true, message: 'Coupon deleted.' });
});

// PROMOTIONS
const { Promotion } = require('../models');

router.get('/promotions', authenticate, requireTenant, requireFeature('storefront'), async (req, res) => {
  const data = await Promotion.find({ tenant_id: req.tenant_id }).sort({ createdAt: -1 });
  res.json({ success: true, data });
});

router.post('/promotions', authenticate, requireTenant, requireFeature('storefront'), businessOwnerOnly, async (req, res) => {
  const { name, discount_type, discount_value, applies_to, category_ids, product_ids, starts_at, ends_at } = req.body;
  if (!name || discount_value === undefined) return res.status(400).json({ success: false, message: 'name and discount_value required.' });
  const data = await Promotion.create({
    tenant_id: req.tenant_id, name,
    discount_type: discount_type || 'percent',
    discount_value: parseFloat(discount_value),
    applies_to: applies_to || 'all',
    category_ids: category_ids || [],
    product_ids: product_ids || [],
    starts_at: starts_at ? new Date(starts_at) : new Date(),
    ends_at: ends_at ? new Date(ends_at) : null,
  });
  res.status(201).json({ success: true, data });
});

router.patch('/promotions/:id', authenticate, requireTenant, requireFeature('storefront'), businessOwnerOnly, async (req, res) => {
  const { is_active, ends_at, name } = req.body;
  const update = {};
  if (is_active !== undefined) update.is_active = is_active;
  if (ends_at !== undefined) update.ends_at = ends_at ? new Date(ends_at) : null;
  if (name !== undefined) update.name = name;
  const data = await Promotion.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, update, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Promotion not found.' });
  res.json({ success: true, data });
});

router.delete('/promotions/:id', authenticate, requireTenant, requireFeature('storefront'), businessOwnerOnly, async (req, res) => {
  await Promotion.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant_id });
  res.json({ success: true });
});

router.get('/storefront/:tenantSlug/settings', storefront.getPublicSettings);
router.get('/storefront/:tenantSlug/orders/:reference', storefront.trackOrder);
router.get('/storefront/categories', async (req, res) => {
  const { Category, Tenant } = require('../models');
  const filter = {};
  if (req.query.tenant_slug) {
    const t = await Tenant.findOne({ slug: req.query.tenant_slug });
    if (t) filter.tenant_id = t._id;
  }
  const data = await Category.find(filter).sort('name');
  res.json({ success: true, data });
});
router.post('/storefront/checkout', orders.initiateCheckout);
router.post('/storefront/verify-payment', orders.verifyPayment);
router.get('/storefront/orders/:orderNumber', storefront.trackOrderLegacy);

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
router.get('/payment-logs', authenticate, requireTenant, requireFeature('accounting'), async (req, res) => {
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

// SUPPLIERS & PURCHASE ORDERS
const procurementRoles = ['business_owner', 'procurement_officer'];
const procurementApproveRoles = ['business_owner', 'accountant'];
const procurementReceiveRoles = ['business_owner', 'warehouse_staff', 'procurement_officer'];
const procurementPayRoles = ['business_owner', 'accountant', 'procurement_officer'];

router.get('/suppliers', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), procurement.listSuppliers);
router.post('/suppliers', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), authorize(...procurementRoles), procurement.createSupplier);
router.put('/suppliers/:id', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), authorize(...procurementRoles), procurement.updateSupplier);
router.delete('/suppliers/:id', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), authorize(...procurementRoles), procurement.deactivateSupplier);

router.get('/purchase-orders', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), procurement.listPurchaseOrders);
router.get('/purchase-orders/:id', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), procurement.getPurchaseOrder);
router.post('/purchase-orders', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), authorize(...procurementRoles), procurement.createPurchaseOrder);
router.put('/purchase-orders/:id', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), authorize(...procurementRoles), procurement.updatePurchaseOrder);
router.patch('/purchase-orders/:id/submit', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), authorize(...procurementRoles), procurement.submitPurchaseOrder);
router.patch('/purchase-orders/:id/approve', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), authorize(...procurementApproveRoles), procurement.approvePurchaseOrder);
router.patch('/purchase-orders/:id/send', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), authorize(...procurementRoles), procurement.sendPurchaseOrder);
router.patch('/purchase-orders/:id/cancel', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), authorize(...procurementRoles, 'accountant'), procurement.cancelPurchaseOrder);
router.patch('/purchase-orders/:id/pay', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), authorize(...procurementPayRoles), procurement.payPurchaseOrder);
router.post('/purchase-orders/:id/receive', authenticate, requireTenant, requireModule('procurement'), requireFeature('procurement'), authorize(...procurementReceiveRoles), procurement.receiveGoods);


router.get('/notifications', authenticate, async (req, res) => {
  if (req.user.role === 'platform_admin') {
    return res.json({ success: true, data: [] });
  }
  const tid = req.tenant_id;
  const [lowStock, pendingLeave, pendingOrders, pendingPOs] = await Promise.all([
    Product.find({ tenant_id: tid, is_active: true, $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] } }).sort('stock_qty').limit(5),
    LeaveRequest.find({ tenant_id: tid, status: 'pending' }).populate('employee_id', 'name').sort({ createdAt: -1 }).limit(5),
    Order.find({ tenant_id: tid, payment_status: 'pending' }).sort({ createdAt: -1 }).limit(5),
    PurchaseOrder.find({ tenant_id: tid, status: 'pending_approval' }).sort({ createdAt: -1 }).limit(5),
  ]);
  const notifications = [
    ...lowStock.map(p => ({ id: `ls-${p._id}`, type: 'warning', title: 'Low Stock', message: `${p.name} has only ${p.stock_qty} units left`, link: '/inventory' })),
    ...pendingLeave.map(l => ({ id: `lv-${l._id}`, type: 'info', title: 'Leave Request', message: `${l.employee_id?.name || 'Employee'} requested ${l.leave_type} leave`, link: '/hr/leave' })),
    ...pendingOrders.map(o => ({ id: `or-${o._id}`, type: 'info', title: 'Unpaid Order', message: `Order ${o.order_number} from ${o.customer_name} is pending payment`, link: '/orders' })),
    ...pendingPOs.map(p => ({ id: `po-${p._id}`, type: 'warning', title: 'PO Awaiting Approval', message: `${p.po_number} needs approval`, link: '/procurement' })),
  ];
  res.json({ success: true, data: notifications });
});

// EMPLOYEE SELF-SERVICE
// Resolves the Employee record for the logged-in user: match by the explicit
// user_id link first, then fall back to a case-insensitive email match (User
// emails are always stored lowercase; Employee emails aren't), auto-linking
// on first successful match so future lookups hit the fast user_id path.
async function resolveEssEmployee(req) {
  const tenantId = req.tenant_id || req.user?.tenant_id;
  const baseFilter = tenantId ? { tenant_id: tenantId } : {};

  let employee = await Employee.findOne({ ...baseFilter, user_id: req.user._id });
  if (!employee && req.user.email) {
    const escaped = req.user.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    employee = await Employee.findOne({ ...baseFilter, email: new RegExp(`^${escaped}$`, 'i') });
  }
  if (employee && !employee.user_id) {
    employee.user_id = req.user._id;
    await employee.save().catch(() => {});
  }
  return employee;
}

router.get('/ess/me', authenticate, async (req, res) => {
  const hrService = require('../services/hrService');
  const employee = await resolveEssEmployee(req);
  if (!employee) return res.json({ success: true, data: null });
  await employee.populate('department_id', 'name');
  await employee.populate('manager_id', 'name');
  const leaveTypes = await hrService.listLeaveTypes(employee.tenant_id || req.user.tenant_id);
  res.json({
    success: true,
    data: {
      ...employee.toJSON(),
      id: employee._id,
      department_name: employee.department_id?.name || null,
      manager_name: employee.manager_id?.name || null,
      leave_balance: hrService.getLeaveBalances(employee, leaveTypes),
    },
  });
});
router.get('/ess/leave-requests', authenticate, async (req, res) => {
  const employee = await resolveEssEmployee(req);
  if (!employee) return res.json({ success: true, data: [] });
  const data = await LeaveRequest.find({ employee_id: employee._id }).sort({ createdAt: -1 });
  res.json({ success: true, data });
});
router.post('/ess/leave-requests', authenticate, async (req, res) => {
  const { leave_type, start_date, end_date, reason } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ success: false, message: 'start_date and end_date required.' });
  const employee = await resolveEssEmployee(req);
  if (!employee) return res.status(404).json({ success: false, message: 'Employee record not found for your account.' });
  const tenant_id = employee.tenant_id || req.user.tenant_id;
  if (!tenant_id) return res.status(400).json({ success: false, message: 'Could not determine tenant for this employee.' });
  // Patch missing tenant_id on the employee record so future requests work
  if (!employee.tenant_id) await Employee.findByIdAndUpdate(employee._id, { tenant_id });
  const data = await LeaveRequest.create({ tenant_id, branch_id: employee.branch_id || null, employee_id: employee._id, leave_type: leave_type || 'annual', start_date, end_date, reason });
  res.status(201).json({ success: true, data });
});
router.get('/ess/payslips', authenticate, async (req, res) => {
  const employee = await resolveEssEmployee(req);
  if (!employee) return res.json({ success: true, data: [] });
  const tenantId = employee.tenant_id || req.tenant_id || req.user?.tenant_id;
  const filter = { employee_id: employee._id, status: { $in: ['submitted', 'approved', 'paid'] } };
  if (tenantId) filter.tenant_id = tenantId;
  if (req.query.month) filter.month = parseInt(req.query.month);
  if (req.query.year)  filter.year  = parseInt(req.query.year);
  const data = await PayrollRun.find(filter).sort({ year: -1, month: -1 });
  res.json({ success: true, data });
});

router.patch('/ess/leave-requests/:id/cancel', authenticate, async (req, res) => {
  const employee = await resolveEssEmployee(req);
  if (!employee) return res.status(404).json({ success: false, message: 'Employee record not found.' });
  const leave = await LeaveRequest.findOne({ _id: req.params.id, employee_id: employee._id });
  if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found.' });
  if (leave.status !== 'pending') return res.status(400).json({ success: false, message: 'Only pending requests can be cancelled.' });
  leave.status = 'rejected';
  await leave.save();
  res.json({ success: true, data: leave });
});

router.get('/ess/attendance', authenticate, async (req, res) => {
  const employee = await resolveEssEmployee(req);
  if (!employee) return res.json({ success: true, data: [] });
  const data = await Attendance.find({ employee_id: employee._id }).sort({ date: -1 }).limit(30);
  res.json({ success: true, data });
});
router.post('/ess/attendance/clock-in', authenticate, async (req, res) => {
  const employee = await resolveEssEmployee(req);
  if (!employee) return res.status(404).json({ success: false, message: 'Employee record not found for your account.' });
  const hrService = require('../services/hrService');
  try {
    const data = await hrService.clockIn(employee.tenant_id || req.user.tenant_id, employee._id, employee.branch_id);
    res.status(201).json({ success: true, data });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
});
router.post('/ess/attendance/clock-out', authenticate, async (req, res) => {
  const employee = await resolveEssEmployee(req);
  if (!employee) return res.status(404).json({ success: false, message: 'Employee record not found for your account.' });
  const hrService = require('../services/hrService');
  try {
    const data = await hrService.clockOut(employee.tenant_id || req.user.tenant_id, employee._id);
    res.json({ success: true, data });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
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

// EMPLOYEES & HR
const hrRoles = ['business_owner', 'hr_manager'];
router.get('/hr/summary', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), hr.hrSummary);
router.get('/employees/linkable-users', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), hr.listLinkableUsers);
router.get('/employees', authenticate, requireTenant, requireModule('hr'), hr.listEmployees);
router.get('/employees/:id', authenticate, requireTenant, requireModule('hr'), hr.getEmployee);
router.post('/employees', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), hr.createEmployee);
router.put('/employees/:id', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), hr.updateEmployee);
router.patch('/employees/:id/terminate', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), hr.terminateEmployee);
router.post(
  '/employees/:id/documents',
  authenticate,
  requireTenant,
  requireModule('hr'),
  authorize(...hrRoles),
  hrDocUpload.single('file'),
  hr.uploadDocument,
);
router.delete('/employees/:id/documents/:docId', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), hr.deleteDocument);

// ATTENDANCE
router.get('/attendance', authenticate, requireTenant, requireModule('hr'), async (req, res) => {
  const filter = { tenant_id: req.tenant_id, ...(req.branchFilter || {}) };
  if (req.query.date) filter.date = new Date(req.query.date);
  const data = await Attendance.find(filter).populate('employee_id', 'name').sort('employee_id');
  const mapped = data.map(a => ({ ...a.toJSON(), employee_name: a.employee_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/attendance', authenticate, requireTenant, requireModule('hr'), authorize('business_owner', 'hr_manager'), async (req, res) => {
  const { employee_id, date, status, notes, clock_in, clock_out } = req.body;
  if (!employee_id || !date) return res.status(400).json({ success: false, message: 'employee_id and date required.' });
  // Attendance follows the employee's branch.
  const emp = await Employee.findOne({ _id: employee_id, tenant_id: req.tenant_id }).select('branch_id');
  const update = { status: status || 'present', notes, branch_id: emp?.branch_id || null };
  if (clock_in) update.clock_in = new Date(clock_in);
  if (clock_out) update.clock_out = new Date(clock_out);
  if (clock_in && clock_out) {
    const hrService = require('../services/hrService');
    const { standardHoursPerDay } = await hrService.getAttendanceSettings(req.tenant_id);
    const hoursWorked = Math.round(Math.max(0, (new Date(clock_out) - new Date(clock_in)) / 3600000) * 100) / 100;
    update.hours_worked = hoursWorked;
    update.overtime_hours = Math.round(Math.max(0, hoursWorked - standardHoursPerDay) * 100) / 100;
  } else if (clock_in && !clock_out) {
    update.hours_worked = undefined;
    update.overtime_hours = undefined;
  }
  const data = await Attendance.findOneAndUpdate(
    { tenant_id: req.tenant_id, employee_id, date: new Date(date) },
    update,
    { upsert: true, new: true }
  );
  res.status(201).json({ success: true, data });
});

// Clock in/out — HR marking on behalf of an employee
router.post('/attendance/clock-in', authenticate, requireTenant, requireModule('hr'), authorize('business_owner', 'hr_manager'), async (req, res) => {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ success: false, message: 'employee_id is required.' });
  const emp = await Employee.findOne({ _id: employee_id, tenant_id: req.tenant_id }).select('branch_id');
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });
  const hrService = require('../services/hrService');
  try {
    const data = await hrService.clockIn(req.tenant_id, employee_id, emp.branch_id);
    res.status(201).json({ success: true, data });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
});
router.post('/attendance/clock-out', authenticate, requireTenant, requireModule('hr'), authorize('business_owner', 'hr_manager'), async (req, res) => {
  const { employee_id } = req.body;
  if (!employee_id) return res.status(400).json({ success: false, message: 'employee_id is required.' });
  const hrService = require('../services/hrService');
  try {
    const data = await hrService.clockOut(req.tenant_id, employee_id);
    res.json({ success: true, data });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
});

// ── ATTENDANCE SETTINGS ──────────────────────────────────────────────────
router.get('/hr/attendance-settings', authenticate, requireTenant, requireModule('hr'), async (req, res) => {
  const hrService = require('../services/hrService');
  const data = await hrService.getAttendanceSettings(req.tenant_id);
  res.json({ success: true, data: { standard_hours_per_day: data.standardHoursPerDay } });
});
router.patch('/hr/attendance-settings', authenticate, requireTenant, businessOwnerOnly, async (req, res) => {
  const hrService = require('../services/hrService');
  const data = await hrService.updateAttendanceSettings(req.tenant_id, req.body);
  res.json({ success: true, data });
});

// ── LEAVE TYPES ──────────────────────────────────────────────────────────
router.get('/leave-types', authenticate, requireTenant, requireModule('hr'), async (req, res) => {
  const hrService = require('../services/hrService');
  const data = await hrService.listLeaveTypes(req.tenant_id);
  res.json({ success: true, data });
});
router.post('/leave-types', authenticate, requireTenant, requireModule('hr'), authorize('business_owner', 'hr_manager'), async (req, res) => {
  const hrService = require('../services/hrService');
  try {
    const data = await hrService.createLeaveType(req.tenant_id, req.body, req.user._id);
    res.status(201).json({ success: true, data });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
});
router.patch('/leave-types/:id', authenticate, requireTenant, requireModule('hr'), authorize('business_owner', 'hr_manager'), async (req, res) => {
  const hrService = require('../services/hrService');
  const data = await hrService.updateLeaveType(req.tenant_id, req.params.id, req.body);
  res.json({ success: true, data });
});

// ── PUBLIC HOLIDAYS ────────────────────────────────────────────────────────
router.get('/holidays', authenticate, requireTenant, requireModule('hr'), async (req, res) => {
  const hrService = require('../services/hrService');
  const data = await hrService.listHolidays(req.tenant_id, req.query.year);
  res.json({ success: true, data });
});
router.post('/holidays', authenticate, requireTenant, requireModule('hr'), authorize('business_owner', 'hr_manager'), async (req, res) => {
  const hrService = require('../services/hrService');
  try {
    const data = await hrService.createHoliday(req.tenant_id, req.body, req.user._id);
    res.status(201).json({ success: true, data });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
});
router.delete('/holidays/:id', authenticate, requireTenant, requireModule('hr'), authorize('business_owner', 'hr_manager'), async (req, res) => {
  const hrService = require('../services/hrService');
  await hrService.deleteHoliday(req.tenant_id, req.params.id);
  res.json({ success: true });
});

// LEAVE REQUESTS
router.get('/leave-requests', authenticate, requireTenant, requireModule('hr'), async (req, res) => {
  const data = await LeaveRequest.find({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) }).populate('employee_id', 'name').sort({ createdAt: -1 });
  const mapped = data.map(l => ({ ...l.toJSON(), employee_name: l.employee_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/leave-requests', authenticate, requireTenant, requireModule('hr'), authorize('business_owner', 'hr_manager'), async (req, res) => {
  const { employee_id, leave_type, start_date, end_date, reason } = req.body;
  if (!employee_id || !start_date || !end_date) return res.status(400).json({ success: false, message: 'employee_id, start_date and end_date required.' });
  // Leave follows the employee's branch.
  const emp = await Employee.findOne({ _id: employee_id, tenant_id: req.tenant_id }).select('branch_id');
  const data = await LeaveRequest.create({ tenant_id: req.tenant_id, branch_id: emp?.branch_id || null, employee_id, leave_type: leave_type || 'annual', start_date, end_date, reason });
  res.status(201).json({ success: true, data });
});
router.patch('/leave-requests/:id', authenticate, requireTenant, requireModule('hr'), authorize('business_owner', 'hr_manager', 'branch_manager'), hr.approveLeave);

// PAYROLL
router.get('/payroll', authenticate, requireTenant, requireModule('hr'), async (req, res) => {
  const data = await PayrollRun.find({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) }).populate('employee_id', 'name').sort({ year: -1, month: -1 });
  const mapped = data.map(p => ({ ...p.toJSON(), employee_name: p.employee_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/payroll', authenticate, requireTenant, authorize(...hrRoles), hr.runPayroll);
router.post('/payroll/bulk', authenticate, requireTenant, authorize(...hrRoles), hr.runBulkPayroll);
router.patch('/payroll/:id/approve', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const data = await PayrollRun.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { status: 'approved', approved_by: req.user._id }, { new: true });
  if (data) {
    const emp = await Employee.findById(data.employee_id).select('name');
    const ref = `${emp?.name || data.employee_id}-${data.month}-${data.year}`;
    await logPayment({ tenant_id: req.tenant_id, source: 'payroll', reference: `PAYROLL-${ref}`, amount: data.net_salary, method: 'bank_transfer', status: 'success', payer_name: emp?.name, description: `Payroll approved for ${emp?.name || data.employee_id} â€” ${data.month}/${data.year}`, source_id: data._id, recorded_by: req.user._id });
    await accounting.postPayrollEntry({
      tenantId: req.tenant_id,
      grossSalary: data.gross_salary,
      allowances: data.allowances || 0,
      paye: data.paye || 0,
      ssnitEmployee: data.ssnit_employee || 0,
      ssnitEmployer: data.ssnit_employer || 0,
      netSalary: data.net_salary,
      reference: ref,
      date: new Date(),
      sourceId: data._id,
      createdBy: req.user._id,
      payFromCash: true,
    }).catch((err) => console.error('[Payroll] GL post failed:', err.message));
  }
  res.json({ success: true, data });
});

// ── PAYROLL SETTINGS ─────────────────────────────────────────────────────
const hrService = require('../services/hrService');

router.get('/hr/payroll-settings', authenticate, requireTenant, requireModule('hr'), async (req, res) => {
  const data = await hrService.getPayrollSettings(req.tenant_id);
  res.json({ success: true, data: { apply_ssnit: data.applySsnit, apply_paye: data.applyPaye } });
});
router.patch('/hr/payroll-settings', authenticate, requireTenant, businessOwnerOnly, async (req, res) => {
  const data = await hrService.updatePayrollSettings(req.tenant_id, req.body);
  res.json({ success: true, data });
});

// ── PAYROLL BATCHES (period pay runs) ──────────────────────────────────────

router.post('/payroll/batches', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  const data = await hrService.runPayrollBatch(req.tenant_id, req.body, req.user._id, req.branchFilter);
  res.status(201).json({ success: true, data });
});

router.get('/payroll/batches', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  const data = await hrService.listPayrollBatches(req.tenant_id, req.branchFilter);
  res.json({ success: true, data });
});

router.get('/payroll/batches/:id', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  const data = await hrService.getPayrollBatch(req.tenant_id, req.params.id);
  res.json({ success: true, data });
});

router.patch('/payroll/batches/:id/approve', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const batch = await hrService.approvePayrollBatch(req.tenant_id, req.params.id, req.user._id);
  const ref = `BATCH-${batch.label?.replace(/\s+/g, '-') || batch._id}`;
  // One aggregate GL entry + payment log for the whole pay run.
  await logPayment({ tenant_id: req.tenant_id, source: 'payroll', reference: `PAYROLL-${ref}`, amount: batch.total_net, method: 'bank_transfer', status: 'success', description: `Payroll approved — ${batch.label} (${batch.employee_count} employees)`, source_id: batch._id, recorded_by: req.user._id });
  await accounting.postPayrollEntry({
    tenantId: req.tenant_id,
    grossSalary: batch.total_gross,
    allowances: batch.total_allowances || 0,
    paye: batch.total_paye || 0,
    ssnitEmployee: batch.total_ssnit_employee || 0,
    ssnitEmployer: batch.total_ssnit_employer || 0,
    netSalary: batch.total_net,
    reference: ref,
    date: new Date(),
    sourceId: batch._id,
    createdBy: req.user._id,
    payFromCash: true,
  }).catch((err) => console.error('[Payroll] Batch GL post failed:', err.message));
  res.json({ success: true, data: batch });
});

router.patch('/payroll/batches/:id/mark-paid', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const data = await hrService.markPayrollBatchPaid(req.tenant_id, req.params.id);
  res.json({ success: true, data });
});

// Bank payment file (CSV) — one row per employee with pay + bank details
router.get('/payroll/batches/:id/bank-file', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  const { batch, runs } = await hrService.getPayrollBatch(req.tenant_id, req.params.id);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Employee Code', 'Employee Name', 'Payment Method', 'Bank', 'Branch', 'Account Name', 'Account Number', 'MoMo Number', 'Net Pay (GHS)'];
  const rows = runs.map((r) => {
    const e = r.employee || {};
    return [e.employee_code, r.employee_name, e.payment_method || 'bank', e.bank_name, e.bank_branch, e.bank_account_name, e.bank_account_number, e.momo_number, (r.net_salary || 0).toFixed(2)].map(esc).join(',');
  });
  const csv = [header.map(esc).join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="bank-file-${(batch.label || 'payrun').replace(/\s+/g, '-')}.csv"`);
  res.send(csv);
});

// ── EMPLOYEE LOANS / SALARY ADVANCES ────────────────────────────────────────
router.get('/loans', authenticate, requireTenant, requireModule('hr'), async (req, res) => {
  const data = await hrService.listLoans(req.tenant_id, { employee_id: req.query.employee_id, status: req.query.status }, req.branchFilter);
  res.json({ success: true, data });
});
router.post('/loans', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  const data = await hrService.createLoan(req.tenant_id, req.body);
  res.status(201).json({ success: true, data });
});
router.get('/loans/:id', authenticate, requireTenant, requireModule('hr'), async (req, res) => {
  const data = await hrService.getLoan(req.tenant_id, req.params.id);
  res.json({ success: true, data });
});
router.patch('/loans/:id/cancel', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  const data = await hrService.cancelLoan(req.tenant_id, req.params.id);
  res.json({ success: true, data });
});

// CRM - CUSTOMERS
router.get('/customers', authenticate, requireTenant, requireModule('crm'), async (req, res) => {
  const data = await Customer.find({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) }).sort({ createdAt: -1 });
  res.json({ success: true, data });
});
router.post('/customers', authenticate, requireTenant, requireModule('crm'), authorize('business_owner', 'sales_staff'), async (req, res) => {
  const { name, email, phone, company, address, segment, notes } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'name required.' });
  const data = await Customer.create({ tenant_id: req.tenant_id, branch_id: await resolveWriteBranchId(req), name, email, phone, company, address, segment: segment || 'general', notes, created_by: req.user._id });
  res.status(201).json({ success: true, data });
});

// CRM - LEADS
router.get('/leads', authenticate, requireTenant, requireModule('crm'), async (req, res) => {
  const data = await Lead.find({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) }).populate('customer_id', 'name').populate('assigned_to', 'name').sort({ createdAt: -1 });
  const mapped = data.map(l => ({ ...l.toJSON(), customer_name: l.customer_id?.name || null, assigned_to_name: l.assigned_to?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/leads', authenticate, requireTenant, requireModule('crm'), authorize('business_owner', 'sales_staff'), async (req, res) => {
  const { customer_id, title, stage, value, assigned_to, notes, next_followup } = req.body;
  if (!title) return res.status(400).json({ success: false, message: 'title required.' });
  const data = await Lead.create({ tenant_id: req.tenant_id, branch_id: await resolveWriteBranchId(req), customer_id: customer_id || null, title, stage: stage || 'new', value: value || 0, assigned_to: assigned_to || null, notes, next_followup: next_followup || null });
  res.status(201).json({ success: true, data });
});
router.patch('/leads/:id', authenticate, requireTenant, requireModule('crm'), async (req, res) => {
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
router.get('/contact-history', authenticate, requireTenant, requireModule('crm'), async (req, res) => {
  const data = await ContactHistory.find({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) }).populate('customer_id', 'name').sort({ contact_date: -1, createdAt: -1 });
  const mapped = data.map(c => ({ ...c.toJSON(), customer_name: c.customer_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/contact-history', authenticate, requireTenant, requireModule('crm'), authorize('business_owner', 'sales_staff'), async (req, res) => {
  const { customer_id, type, notes, contact_date } = req.body;
  const data = await ContactHistory.create({ tenant_id: req.tenant_id, branch_id: await resolveWriteBranchId(req), customer_id: customer_id || null, type: type || 'call', notes, contact_date: contact_date || Date.now(), created_by: req.user._id });
  res.status(201).json({ success: true, data });
});


// REPORTS — advanced analytics (routes/reports.js)
router.use(reportsRouter);


// â”€â”€ ACCOUNTING MODULE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// All accounting routes live in routes/accounting.js
// This is the standalone boundary â€” this router can be extracted independently
router.use('/', accountingRouter);

// STORAGE LOCATIONS
const assets = require('../controllers/assetController');
router.get('/locations',              authenticate, requireTenant, assets.getLocations);
router.post('/locations',             authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), assets.createLocation);
router.put('/locations/:id',          authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), assets.updateLocation);
router.delete('/locations/:id',       authenticate, requireTenant, authorize('business_owner','branch_manager'), assets.deleteLocation);

// ASSET CATEGORIES
router.get('/asset-categories',       authenticate, requireTenant, assets.getAssetCategories);
router.post('/asset-categories',      authenticate, requireTenant, authorize('business_owner','branch_manager'), assets.createAssetCategory);
router.put('/asset-categories/:id',   authenticate, requireTenant, authorize('business_owner','branch_manager'), assets.updateAssetCategory);
router.delete('/asset-categories/:id',authenticate, requireTenant, authorize('business_owner','branch_manager'), assets.deleteAssetCategory);

// ASSETS
router.get('/assets',                 authenticate, requireTenant, assets.getAssets);
router.get('/assets/:id',             authenticate, requireTenant, assets.getAsset);
router.post('/assets',                authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), assets.createAsset);
router.put('/assets/:id',             authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), assets.updateAsset);
router.post('/assets/:id/log',        authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), assets.addAssetLog);

// CHAT
const chat = require('../controllers/chatController');
router.get('/chat/conversation',                  authenticate, requireTenant, chat.getOrCreateConversation);
router.get('/chat/messages/:conversationId',      authenticate, chat.getMessages);
router.post('/chat/messages',                     authenticate, chat.sendMessage);
router.get('/chat/admin/conversations',           authenticate, platformAdminOnly, chat.getAllConversations);
router.patch('/chat/conversations/:id/resolve',   authenticate, platformAdminOnly, chat.resolveConversation);

module.exports = router;
