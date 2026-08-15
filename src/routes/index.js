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
const { imageUpload, hrDocUpload, serviceUpload } = require('../middleware/uploadMiddleware');
const orders = require('../controllers/ordersController');
const { deductItemStock } = require('../controllers/ordersController');
const { availableQty } = require('../services/stockService');
const { isShopItem } = require('../services/offeringService');
const variantService = require('../services/variantService');
const productReviews = require('../controllers/reviewController');

/**
 * Attach the store customer when there is one, and carry on when there is not.
 *
 * Reviews work either way: signed in, the shop knows who you are; as a guest,
 * you give the email your receipt went to and the order lookup proves it.
 *
 * So this cannot delegate to authenticateStoreCustomer, which answers 401 for a
 * missing or expired token — a customer whose session lapsed while reading a
 * product page would be refused rather than quietly falling back to the guest
 * path, which needs no token at all. It verifies for itself and never fails the
 * request: no token, a bad one, or an expired one all mean the same thing here,
 * which is that entitlement has to come from the order lookup instead.
 */
const maybeStoreCustomer = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.type === 'store_customer') {
      const { StoreCustomer } = require('../models');
      const customer = await StoreCustomer.findById(decoded.id);
      if (customer) req.storeCustomer = customer;
    }
  } catch { /* A guest with a stale token is still a guest. */ }
  next();
};
const procurement = require('../controllers/procurementController');
const storefront = require('../controllers/storefrontController');
const payout = require('../controllers/payoutController');
const paystackSubaccount = require('../controllers/paystackSubaccountController');
const sms = require('../controllers/smsController');
const emailSettings = require('../controllers/emailController');
const projects = require('../controllers/projectController');
const contracts = require('../controllers/contractController');
const jobs = require('../controllers/jobController');
const labour = require('../controllers/labourController');
const serviceRequests = require('../controllers/serviceRequestController');
const clientPortal = require('../controllers/clientPortalController');
const tracking = require('../services/trackingService');
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
  if (data.mnotify_api_key) data.mnotify_api_key = 'MASKED' + data.mnotify_api_key.slice(-4);
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
    audit_retention_days, feature_flags, marketplace_commission_pct,
    sms_bundles, sms_sender_id, mnotify_api_key,
  } = req.body;
  let settings = await PlatformSettings.findOne();
  if (!settings) settings = new PlatformSettings();
  const fields = {
    trial_days, grace_days, currency, auto_renew_default,
    platform_name, support_email, platform_logo,
    paystack_public_key, paystack_webhook_url,
    paystack_virtual_terminal_code, paystack_terminal_whatsapp,
    trial_warning_days, expiry_alert_days, audit_retention_days,
    marketplace_commission_pct, sms_sender_id,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) settings[k] = v;
  }
  // Same masking rule as the Paystack secret: a masked value means "unchanged".
  if (mnotify_api_key !== undefined && !String(mnotify_api_key).startsWith('MASKED')) {
    settings.mnotify_api_key = String(mnotify_api_key).trim();
  }
  // Only update secret key if a real value (not masked) is provided
  if (paystack_secret_key && !paystack_secret_key.startsWith('â€¢â€¢â€¢â€¢')) {
    settings.paystack_secret_key = paystack_secret_key;
  }
  if (plans !== undefined) { settings.plans = plans; settings.markModified('plans'); }
  if (feature_flags !== undefined) { settings.feature_flags = feature_flags; settings.markModified('feature_flags'); }
  // Mixed type, so Mongoose needs telling it changed. Rejects malformed rows
  // rather than storing a bundle a tenant could not actually buy.
  if (sms_bundles !== undefined) {
    if (!Array.isArray(sms_bundles)) {
      return res.status(400).json({ success: false, message: 'sms_bundles must be an array.' });
    }
    const clean = sms_bundles
      .map((b) => ({ label: String(b?.label || '').trim(), credits: Number(b?.credits), price: Number(b?.price) }))
      .filter((b) => b.label && Number.isFinite(b.credits) && b.credits > 0 && Number.isFinite(b.price) && b.price >= 0);
    if (clean.length !== sms_bundles.length) {
      return res.status(400).json({ success: false, message: 'Every bundle needs a label, a credit count above zero and a price.' });
    }
    settings.sms_bundles = clean;
    settings.markModified('sms_bundles');
  }
  await settings.save();
  const { invalidatePlatformSettingsCache } = require('../services/tenantService');
  const { invalidatePaystackCredentialsCache } = require('../services/paymentService');
  invalidatePlatformSettingsCache();
  invalidatePaystackCredentialsCache();
  const data = settings.toJSON();
  if (data.paystack_secret_key) data.paystack_secret_key = 'â€¢â€¢â€¢â€¢â€¢â€¢â€¢â€¢' + data.paystack_secret_key.slice(-4);
  if (data.mnotify_api_key) data.mnotify_api_key = 'MASKED' + data.mnotify_api_key.slice(-4);
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
  const { name, description, custom_fields, scope } = req.body;
  const { Category } = require('../models');
  const data = await Category.create({ tenant_id: req.tenant_id, name, description, scope: scope || 'product', custom_fields: custom_fields || [] });
  res.status(201).json({ success: true, data });
});
router.put('/categories/:id', authenticate, requireTenant, authorize('business_owner','branch_manager','warehouse_staff'), async (req, res) => {
  const { name, description, custom_fields, scope } = req.body;
  const { Category } = require('../models');
  const data = await Category.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    { name, description, ...(custom_fields !== undefined && { custom_fields }), ...(scope !== undefined && { scope }) },
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
    revenueAccountCode: order.items.some((i) => i.item_type !== 'service') ? '4001' : '4010',
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
    await deductItemStock({ item, tenantId: req.tenant_id, branchId: order.branch_id || null, orderNumber: order.order_number, createdBy: req.user._id });
  }
  const hasProduct = order.items.some((i) => i.item_type !== 'service');
  const hasService = order.items.some((i) => i.item_type === 'service');
  const revenueAccountCode = hasProduct ? '4001' : hasService ? '4010' : '4001';
  await logPayment({ tenant_id: req.tenant_id, source: 'internal_order', reference: order.order_number, amount: order.total, method: payment_method || 'cash', status: 'success', payer_name: order.customer_name, payer_email: order.customer_email, description: `Payment collected for order ${order.order_number}`, source_id: order._id, recorded_by: req.user._id });
  await accounting.postSaleEntry({ tenantId: req.tenant_id, amount: order.total, cogsAmount: order.subtotal, taxAmount: order.tax_amount || 0, reference: order.order_number, date: new Date(), sourceId: order._id, createdBy: req.user._id, revenueAccountCode }).catch(() => {});
  res.json({ success: true, message: 'Order marked as paid.', data: order });
});

// MARKETPLACE — cross-tenant shop directory (public, no auth)
router.get('/marketplace/shops', async (req, res) => {
  const { Tenant, Product } = require('../models');
  const tenants = await Tenant.find({
    is_active: true,
    subscription_status: { $in: ['trial', 'active'] },
    'storefront_settings.store_enabled': true,
  }).select('business_name slug logo storefront_settings.announcement').sort('business_name');

  const tenantIds = tenants.map((t) => t._id);
  // The same test the storefront itself applies, so the directory advertises
  // what a shopper would actually find — a shop whose whole list is held back
  // from the store has nothing to show and does not belong here.
  const products = await Product.find({
    tenant_id: { $in: tenantIds },
    is_active: true,
    sell_online: { $ne: false },
    pricing_mode: { $ne: 'open' },
  })
    .select('tenant_id images category_id')
    .populate('category_id', 'name')
    .sort('-createdAt')
    .limit(2000);

  const byTenant = {};
  for (const p of products) {
    const key = String(p.tenant_id);
    if (!byTenant[key]) byTenant[key] = { count: 0, images: [], categories: new Set() };
    const bucket = byTenant[key];
    bucket.count += 1;
    if (bucket.images.length < 4 && p.images && p.images[0]) bucket.images.push(p.images[0]);
    if (p.category_id?.name && bucket.categories.size < 4) bucket.categories.add(p.category_id.name);
  }

  const shops = tenants
    .map((t) => {
      const bucket = byTenant[String(t._id)] || { count: 0, images: [], categories: new Set() };
      return {
        id: t._id,
        business_name: t.business_name,
        slug: t.slug,
        logo: t.logo || '',
        announcement: t.storefront_settings?.announcement || '',
        product_count: bucket.count,
        sample_images: bucket.images,
        categories: Array.from(bucket.categories),
      };
    })
    .filter((s) => s.product_count > 0);

  res.json({ success: true, data: shops });
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
// One product, by the address a customer was given. Declared before the
// tenant-scoped settings routes below so ':tenantSlug' cannot swallow it.
router.get('/storefront/:tenantSlug/products/:productSlug', orders.getStorefrontProduct);
router.get('/storefront/settings', authenticate, requireTenant, requireFeature('storefront'), storefront.getMerchantSettings);
router.put('/storefront/settings', authenticate, requireTenant, requireFeature('storefront'), storefront.updateMerchantSettings);
// The picture behind the shop's headline. Same guard as the settings it is
// saved into, so anybody who can change the shop front can supply its image.
router.post(
  '/uploads/storefront-image',
  authenticate,
  requireTenant,
  requireFeature('storefront'),
  imageUpload.single('image'),
  upload.uploadStorefrontImage,
);
// The shop's mark. Same guard, same shape.
router.post(
  '/uploads/logo',
  authenticate,
  requireTenant,
  requireFeature('storefront'),
  imageUpload.single('image'),
  upload.uploadLogo,
);

// Payout methods — a branch manager manages the account their own branch is
// paid into; a business owner manages those plus the organisation-wide one.
const payoutManagers = authorize('platform_admin', 'business_owner', 'branch_manager');

router.get('/payout-methods', authenticate, requireTenant, payoutManagers, payout.list);
router.post('/payout-methods', authenticate, requireTenant, payoutManagers, payout.create);
router.patch('/payout-methods/:id/default', authenticate, requireTenant, payoutManagers, payout.setDefault);
router.delete('/payout-methods/:id', authenticate, requireTenant, payoutManagers, payout.remove);

// Platform's own mNotify balance — the stock behind what tenants buy.
router.get('/platform/sms/balance', authenticate, platformAdminOnly, async (req, res) => {
  const { getProviderBalance } = require('../services/smsService');
  try {
    res.json({ success: true, data: await getProviderBalance() });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Could not reach the SMS gateway.' });
  }
});

// PROJECTS — contract work, weighted progress and cost against budget.
const projectManagers = authorize('platform_admin', 'business_owner', 'branch_manager', 'accountant');
const contractManagers = authorize('platform_admin', 'business_owner', 'branch_manager', 'accountant');

const serviceManagers = authorize('platform_admin', 'business_owner', 'branch_manager', 'sales_staff');

// ── CONTRACTS ────────────────────────────────────────────────────────────────
router.get('/contracts',                              authenticate, requireTenant, contractManagers, contracts.list);
// JOBS — daily internal work, no quote cycle.
const jobManagers = authorize('platform_admin', 'business_owner', 'branch_manager', 'sales_staff', 'accountant');
router.get('/jobs',              authenticate, requireTenant, jobManagers, jobs.list);
router.post('/jobs',             authenticate, requireTenant, jobManagers, jobs.create);
router.get('/jobs/:id',          authenticate, requireTenant, jobManagers, jobs.get);
router.put('/jobs/:id',          authenticate, requireTenant, jobManagers, jobs.update);
router.delete('/jobs/:id',       authenticate, requireTenant, businessOwnerOnly, jobs.remove);
router.post('/jobs/:id/invoice', authenticate, requireTenant, jobManagers, jobs.invoice);

router.post('/contracts',                             authenticate, requireTenant, contractManagers, contracts.create);
router.get('/contracts/:id',                          authenticate, requireTenant, contractManagers, contracts.get);
router.put('/contracts/:id',                          authenticate, requireTenant, contractManagers, contracts.update);
router.delete('/contracts/:id',                       authenticate, requireTenant, businessOwnerOnly, contracts.remove);
router.post('/contracts/:id/projects/:projectId',     authenticate, requireTenant, contractManagers, contracts.linkProject);
router.delete('/contracts/:id/projects/:projectId',   authenticate, requireTenant, contractManagers, contracts.unlinkProject);
router.post('/contracts/:id/documents',               authenticate, requireTenant, contractManagers, hrDocUpload.single('file'), contracts.uploadDocument);
router.delete('/contracts/:id/documents/:docId',      authenticate, requireTenant, contractManagers, contracts.removeDocument);
router.post('/contracts/:id/notes',                   authenticate, requireTenant, contractManagers, contracts.addNote);
router.delete('/contracts/:id/notes/:noteId',         authenticate, requireTenant, contractManagers, contracts.removeNote);
router.post('/contracts/:id/payment-schedule',                          authenticate, requireTenant, contractManagers, contracts.addPaymentMilestone);
router.put('/contracts/:id/payment-schedule/:milestoneId',              authenticate, requireTenant, contractManagers, contracts.updatePaymentMilestone);
router.delete('/contracts/:id/payment-schedule/:milestoneId',           authenticate, requireTenant, contractManagers, contracts.removePaymentMilestone);
router.post('/contracts/:id/signatories',                               authenticate, requireTenant, contractManagers, contracts.addSignatory);
router.put('/contracts/:id/signatories/:signatoryId',                   authenticate, requireTenant, contractManagers, contracts.updateSignatory);
router.delete('/contracts/:id/signatories/:signatoryId',                authenticate, requireTenant, contractManagers, contracts.removeSignatory);

// ── PROJECTS ──────────────────────────────────────────────────────────────────
router.get('/projects/types',              authenticate, requireTenant, requireFeature('projects'), projects.listTypes);
router.get('/projects',                    authenticate, requireTenant, requireFeature('projects'), projects.list);
router.post('/projects',                   authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.create);
router.get('/projects/:id',                authenticate, requireTenant, requireFeature('projects'), projects.get);
router.put('/projects/:id',                authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.update);
router.delete('/projects/:id',             authenticate, requireTenant, requireFeature('projects'), businessOwnerOnly, projects.remove);
router.get('/projects/:id/financials',     authenticate, requireTenant, requireFeature('projects'), projects.financials);

router.post('/projects/:id/milestones',              authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.addMilestone);
router.put('/projects/:id/milestones/:milestoneId',  authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.updateMilestone);
router.delete('/projects/:id/milestones/:milestoneId', authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.removeMilestone);

router.post('/projects/:id/tasks',           authenticate, requireTenant, requireFeature('projects'), projects.addTask);
router.put('/projects/:id/tasks/:taskId',    authenticate, requireTenant, requireFeature('projects'), projects.updateTask);
router.delete('/projects/:id/tasks/:taskId', authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.removeTask);

router.post('/projects/:id/variations',                    authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.addVariation);
router.patch('/projects/:id/variations/:variationId',      authenticate, requireTenant, requireFeature('projects'), businessOwnerOnly, projects.decideVariation);
router.delete('/projects/:id/variations/:variationId',     authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.removeVariation);

router.patch('/projects/:id/documents/:documentId/share', authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.shareDocument);
router.get('/projects/:id/messages',         authenticate, requireTenant, requireFeature('projects'), projects.listMessages);
router.post('/projects/:id/messages',        authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.postMessage);

router.post('/projects/:id/track-link',      authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.trackLink);
router.delete('/projects/:id/track-link',    authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.revokeTrackLink);

router.get('/projects/:id/baseline',         authenticate, requireTenant, requireFeature('projects'), projects.listBaselines);
router.post('/projects/:id/baseline',        authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.setBaseline);
router.get('/projects/:id/schedule',         authenticate, requireTenant, requireFeature('projects'), projects.schedule);
router.get('/projects/:id/cashflow',         authenticate, requireTenant, requireFeature('projects'), projects.cashflow);

router.get('/projects/:id/eot',              authenticate, requireTenant, requireFeature('projects'), projects.listEot);
router.get('/projects/:id/eot/analysis',     authenticate, requireTenant, requireFeature('projects'), projects.eotAnalysis);
router.post('/projects/:id/eot',             authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.createEot);
router.patch('/projects/:id/eot/:claimId',   authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.updateEot);
// Deciding a claim moves the completion date, so it sits with the owner.
router.patch('/projects/:id/eot/:claimId/decision', authenticate, requireTenant, requireFeature('projects'), businessOwnerOnly, projects.decideEot);
router.delete('/projects/:id/eot/:claimId',  authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.removeEot);

router.get('/projects/:id/billing',          authenticate, requireTenant, requireFeature('projects'), projects.billing);
router.post('/projects/:id/invoices',        authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.createProgressInvoice);
router.post('/projects/:id/retention-release', authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.releaseRetention);
router.get('/projects/:id/invoices/:invoiceId/certificate', authenticate, requireTenant, requireFeature('projects'), projects.certificate);

router.get('/projects/:id/diary',              authenticate, requireTenant, requireFeature('projects'), projects.listDiary);
router.post('/projects/:id/diary',             authenticate, requireTenant, requireFeature('projects'), projects.saveDiary);
router.delete('/projects/:id/diary/:entryId',  authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.removeDiary);

router.get('/projects/:id/documents',                   authenticate, requireTenant, requireFeature('projects'), projects.listDocuments);
router.post('/projects/:id/documents',                  authenticate, requireTenant, requireFeature('projects'), hrDocUpload.single('file'), projects.uploadDocument);
router.delete('/projects/:id/documents/:documentId',    authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.removeDocument);

router.get('/service-requests/types',         authenticate, requireTenant, serviceManagers, serviceRequests.typeCatalogue);
router.get('/service-requests',               authenticate, requireTenant, serviceManagers, serviceRequests.list);
router.get('/service-requests/:id',           authenticate, requireTenant, serviceManagers, serviceRequests.get);
router.post('/service-requests/:id/quote',    authenticate, requireTenant, serviceManagers, serviceRequests.quote);
router.patch('/service-requests/:id/stage',   authenticate, requireTenant, serviceManagers, serviceRequests.setStage);

router.get('/labour/board',      authenticate, requireTenant, requireFeature('projects'), projectManagers, labour.board);
router.get('/labour/by-project', authenticate, requireTenant, requireFeature('projects'), projectManagers, labour.byProject);
router.post('/labour/allocate',  authenticate, requireTenant, requireFeature('projects'), projectManagers, labour.allocate);

router.get('/projects/:id/time',           authenticate, requireTenant, requireFeature('projects'), projects.listTime);
router.post('/projects/:id/time',          authenticate, requireTenant, requireFeature('projects'), projects.logTime);
router.delete('/projects/:id/time/:logId', authenticate, requireTenant, requireFeature('projects'), projectManagers, projects.removeTime);

// SMS — prepaid credits resold by the platform, plus per-tenant templates.
router.get('/sms/balance',              authenticate, requireTenant, sms.getBalance);
router.put('/sms/settings',             authenticate, requireTenant, businessOwnerOnly, sms.updateSettings);
router.post('/sms/purchase',            authenticate, requireTenant, businessOwnerOnly, sms.purchase);
router.post('/sms/purchase/verify',     authenticate, requireTenant, businessOwnerOnly, sms.verifyPurchase);
router.get('/sms/purchases',            authenticate, requireTenant, businessOwnerOnly, sms.listPurchases);
router.get('/sms/templates',            authenticate, requireTenant, sms.listTemplates);
router.put('/sms/templates/:key',       authenticate, requireTenant, businessOwnerOnly, sms.updateTemplate);
router.post('/sms/templates/:key/reset', authenticate, requireTenant, businessOwnerOnly, sms.resetTemplate);
router.post('/sms/preview',             authenticate, requireTenant, sms.previewTemplate);
router.get('/sms/messages',             authenticate, requireTenant, sms.listMessages);
router.post('/sms/send',                authenticate, requireTenant, businessOwnerOnly, sms.sendTest);

// EMAIL — the tenant's own mailbox, their own wording. Nothing is charged for
// it, so unlike SMS there is nothing to buy and no balance to guard.
router.get('/email/settings',              authenticate, requireTenant, businessOwnerOnly, emailSettings.getSettings);
router.put('/email/settings',              authenticate, requireTenant, businessOwnerOnly, emailSettings.updateSettings);
router.post('/email/verify',               authenticate, requireTenant, businessOwnerOnly, emailSettings.verify);
router.get('/email/templates',             authenticate, requireTenant, emailSettings.listTemplates);
router.put('/email/templates/:key',        authenticate, requireTenant, businessOwnerOnly, emailSettings.updateTemplate);
router.post('/email/templates/:key/reset', authenticate, requireTenant, businessOwnerOnly, emailSettings.resetTemplate);
router.post('/email/preview',              authenticate, requireTenant, emailSettings.previewTemplate);
router.get('/email/messages',              authenticate, requireTenant, emailSettings.listMessages);
router.post('/email/send',                 authenticate, requireTenant, businessOwnerOnly, emailSettings.send);

// Paystack subaccount — opts the tenant into gateway-level payment splitting.
router.get('/paystack/banks', authenticate, requireTenant, businessOwnerOnly, paystackSubaccount.listBanks);
router.get('/paystack/subaccount', authenticate, requireTenant, payoutManagers, paystackSubaccount.get);
router.post('/paystack/subaccount', authenticate, requireTenant, businessOwnerOnly, paystackSubaccount.connect);
router.delete('/paystack/subaccount', authenticate, requireTenant, businessOwnerOnly, paystackSubaccount.disconnect);

// Payouts — collected takings and withdrawals against them.
router.get('/payouts/balance', authenticate, requireTenant, payoutManagers, payout.balance);
router.get('/payouts/settings', authenticate, requireTenant, payoutManagers, payout.getSettings);
router.put('/payouts/settings', authenticate, requireTenant, businessOwnerOnly, payout.updateSettings);
router.get('/payouts', authenticate, requireTenant, payoutManagers, payout.listPayouts);
router.post('/payouts', authenticate, requireTenant, payoutManagers, payout.requestPayout);
router.get('/storefront/resolve-domain', storefront.resolveDomain);

/* ── Public: tracking a job, and sending one in ──────────────────────────────
 *
 * No authentication. The token in the URL is the authority — it is unguessable
 * and was handed to the person entitled to see what it points at. Everything
 * these return is built by trackingService as a whitelist, never a trimmed
 * internal record. */
router.get('/track/:token', async (req, res) => {
  const data = await tracking.resolve(req.params.token);
  if (!data) return res.status(404).json({ success: false, message: 'That link is not valid, or has been withdrawn.' });
  res.json({ success: true, data });
});

// What customers said. Reading is open; leaving one requires having bought it,
// which is established from a paid order rather than from a claim — see
// services/reviewService.
router.get('/storefront/:tenantSlug/products/:productSlug/reviews', productReviews.listReviews);
router.get('/storefront/:tenantSlug/products/:productSlug/reviews/eligibility', maybeStoreCustomer, productReviews.reviewEligibility);
router.post('/storefront/:tenantSlug/products/:productSlug/reviews', maybeStoreCustomer, productReviews.createReview);

router.get('/service-requests/:tenantSlug/services', serviceRequests.publicServices);
router.post('/service-requests/:tenantSlug', serviceUpload.array('files', 10), serviceRequests.submitRequest);
// The intake page was /print before it handled anything else, and clients were
// given that link. Kept pointing at the same handlers so those links still work.
router.get('/print-requests/:tenantSlug/services', serviceRequests.publicServices);
router.post('/print-requests/:tenantSlug', serviceUpload.array('files', 10), serviceRequests.submitRequest);
router.post('/track/:token/quote-response', serviceRequests.respondToQuote);
router.post('/track/:token/pay',            serviceRequests.startPayment);
router.post('/track/:token/confirm-payment', serviceRequests.confirmPayment);

router.get('/track/:token/documents',       clientPortal.listDocuments);
router.post('/track/:token/documents',      hrDocUpload.single('file'), clientPortal.uploadDocument);
router.get('/track/:token/messages',        clientPortal.listMessages);
router.post('/track/:token/messages',       clientPortal.postMessage);
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
  const { cart_id, product_id, quantity = 1, tenant_id, variant_key, selections } = req.body;
  if (!product_id) return res.status(400).json({ success: false, message: 'product_id required.' });
  const product = await Product.findOne({ _id: product_id, is_active: true }).populate('category_id', 'name').populate('branch_id', 'name slug');
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
  // A cart is for things that are bought. Work is asked for, looked at and
  // quoted before anybody commits to a price, which is what the request desk
  // is for — so a service cannot be put in a basket even by a client that
  // still has yesterday's catalogue open.
  if (!(await isShopItem(product))) {
    return res.status(409).json({
      success: false,
      message: `${product.name} is a service — send a request and we'll price it for you.`,
    });
  }
  // Which one of it. Accepted either as the key the catalogue handed out or as
  // the raw selections, because an integration posting {Size:'M'} means exactly
  // the same thing as the storefront posting the key it was given.
  const chosenKey = variant_key || variantService.variantKey(selections);
  const problem = variantService.variantProblem(product, chosenKey);
  if (problem) return res.status(400).json({ success: false, message: problem });
  const chosen = variantService.findVariant(product, chosenKey);

  const cart = await getOrCreateCart(cart_id, tenant_id || product.tenant_id);
  // A line is a product *and* a choice: two navy mediums is one line, but a
  // navy medium and a white large are two, or a customer buying both would
  // silently end up with two of whichever the cart happened to record.
  const existing = cart.items.find(i =>
    String(i.product_id) === String(product._id) && (i.variant_key || '') === (chosen?.key || ''));
  // How many of this could actually be sold, asked of the one place that knows.
  //
  // This route capped every non-service at its own stock_qty. A bundle keeps no
  // stock of its own — what limits it is the scarcest of its parts — so the cap
  // was zero, and adding one to a cart quietly wrote a line for nought of it.
  // stockService has answered this correctly for services and bundles since it
  // was written; the cart was the caller still working it out for itself.
  const ceiling = await availableQty({ tenantId: product.tenant_id, product, variantKey: chosen?.key });
  // Nothing left is refused outright rather than added as a zero-quantity line
  // the customer can neither see nor remove.
  if (ceiling < 1) {
    return res.status(409).json({ success: false, message: `${product.name} is out of stock.` });
  }
  if (existing) {
    existing.quantity = Math.min(existing.quantity + quantity, ceiling);
  } else {
    cart.items.push({
      product_id:          product._id,
      product_name:        product.name,
      // Priced from the row, so an extra-large that costs more actually does.
      price:               variantService.priceOf(product, chosen),
      variant_key:         chosen?.key || '',
      variant_label:       variantService.variantLabel(chosen),
      quantity:            Math.min(quantity, ceiling),
      images:              product.images,
      category_name:       product.category_id?.name || '',
      stock_qty:           product.stock_qty,
      low_stock_threshold: product.low_stock_threshold,
      sku:                 product.sku,
      branch_id:           product.branch_id?._id || product.branch_id || null,
      branch_name:         product.branch_id?.name || 'Main Branch',
      branch_slug:         product.branch_id?.slug || 'main',
      item_type:           product.item_type || 'product',
      unit_type:           product.unit_type || null,
      duration:            product.duration || null,
    });
  }
  cart.expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await cart.save();
  res.json({ success: true, data: cart });
});

router.patch('/storefront/cart/update', async (req, res) => {
  const { cart_id, product_id, quantity, variant_key } = req.body;
  if (!cart_id || !product_id) return res.status(400).json({ success: false, message: 'cart_id and product_id required.' });
  const cart = await Cart.findOne({ cart_id });
  if (!cart) return res.status(404).json({ success: false, message: 'Cart not found.' });

  // Product and choice together, the same identity the cart was built with.
  // Keyed on the product alone, changing the quantity of a navy medium would
  // have found whichever polo shirt line came first and changed that instead.
  const wanted = variant_key || '';
  const isLine = i => String(i.product_id) === String(product_id) && (i.variant_key || '') === wanted;

  if (quantity <= 0) {
    cart.items = cart.items.filter(i => !isLine(i));
  } else {
    const item = cart.items.find(isLine);
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
const payrollRates = require('../config/payrollRates');
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
router.get('/ess/appraisals', authenticate, async (req, res) => {
  const employee = await resolveEssEmployee(req);
  if (!employee) return res.json({ success: true, data: [] });
  const hrService = require('../services/hrService');
  const data = await hrService.listMyAppraisals(employee.tenant_id || req.user.tenant_id, employee._id);
  res.json({ success: true, data });
});
router.patch('/ess/appraisals/:id/acknowledge', authenticate, async (req, res) => {
  const employee = await resolveEssEmployee(req);
  if (!employee) return res.status(404).json({ success: false, message: 'Employee record not found for your account.' });
  const hrService = require('../services/hrService');
  try {
    const data = await hrService.acknowledgeAppraisal(employee.tenant_id || req.user.tenant_id, req.params.id, employee._id, req.body.employee_comments);
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
router.get('/hr/report', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), hr.hrReport);
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
  res.json({ success: true, data: { standard_hours_per_day: data.standardHoursPerDay, overtime_multiplier: data.overtimeMultiplier } });
});
router.patch('/hr/attendance-settings', authenticate, requireTenant, businessOwnerOnly, async (req, res) => {
  const hrService = require('../services/hrService');
  const data = await hrService.updateAttendanceSettings(req.tenant_id, req.body);
  res.json({ success: true, data });
});

// ── HR SETTINGS (leave defaults, tier 3, payslip branding) ───────────────
router.get('/hr/settings', authenticate, requireTenant, requireModule('hr'), async (req, res) => {
  const hrService = require('../services/hrService');
  const data = await hrService.getHrSettings(req.tenant_id);
  res.json({ success: true, data });
});
router.patch('/hr/settings', authenticate, requireTenant, businessOwnerOnly, async (req, res) => {
  const hrService = require('../services/hrService');
  const data = await hrService.updateHrSettings(req.tenant_id, req.body);
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
  const now = new Date();
  res.json({
    success: true,
    data: {
      apply_ssnit: data.applySsnit,
      apply_paye: data.applyPaye,
      // The tenant's own dated schedules, empty when they follow the national one.
      paye_bands: data.payeSchedule,
      pension_rates: data.pensionSchedule,
      // And what those resolve to today, so the page can show the figures in
      // force without repeating the resolution rules in the browser.
      in_force: {
        paye_bands: payrollRates.payeBandsFor(now, data.payeSchedule),
        pension_rates: payrollRates.pensionRatesFor(now, data.pensionSchedule),
        following_national: !data.payeSchedule.length && !data.pensionSchedule.length,
      },
      national: {
        paye_bands: payrollRates.PAYE_SCHEDULE[payrollRates.PAYE_SCHEDULE.length - 1],
        pension_rates: payrollRates.PENSION_SCHEDULE[payrollRates.PENSION_SCHEDULE.length - 1],
      },
    },
  });
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

// ── PERFORMANCE APPRAISALS ───────────────────────────────────────────────────
router.get('/appraisals', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  const data = await hrService.listAppraisals(req.tenant_id, req.branchFilter, { employee_id: req.query.employee_id });
  res.json({ success: true, data });
});
router.post('/appraisals', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  const data = await hrService.createAppraisal(req.tenant_id, req.body, req.user._id);
  res.status(201).json({ success: true, data });
});
router.get('/appraisals/categories', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), (req, res) => {
  res.json({ success: true, data: hrService.getAppraisalCategories() });
});
router.get('/appraisals/:id', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  const data = await hrService.getAppraisal(req.tenant_id, req.params.id);
  res.json({ success: true, data });
});
router.put('/appraisals/:id', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  const data = await hrService.updateAppraisal(req.tenant_id, req.params.id, req.body);
  res.json({ success: true, data });
});
router.patch('/appraisals/:id/submit', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  const data = await hrService.submitAppraisal(req.tenant_id, req.params.id);
  res.json({ success: true, data });
});
router.delete('/appraisals/:id', authenticate, requireTenant, requireModule('hr'), authorize(...hrRoles), async (req, res) => {
  await hrService.deleteAppraisal(req.tenant_id, req.params.id);
  res.json({ success: true });
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
