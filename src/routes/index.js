const express = require('express');
const router = express.Router();
const { authenticate, authorize, superAdminOnly } = require('../middleware/auth');
const auth = require('../controllers/authController');
const users = require('../controllers/usersController');
const dashboard = require('../controllers/dashboardController');
const inventory = require('../controllers/inventoryController');
const orders = require('../controllers/ordersController');
const {
  Supplier, PurchaseOrder, Product, StockMovement,
  Account, Expense, JournalEntry, TaxRate,
  Department, Employee, Attendance, LeaveRequest, PayrollRun,
  Customer, Lead, ContactHistory, Order,
} = require('../models');

// AUTH
router.post('/auth/login', auth.login);
router.get('/auth/me', authenticate, auth.getMe);
router.post('/auth/change-password', authenticate, auth.changePassword);

// USERS
router.get('/users', authenticate, superAdminOnly, users.getUsers);
router.get('/users/:id', authenticate, superAdminOnly, users.getUser);
router.post('/users', authenticate, superAdminOnly, users.createUser);
router.put('/users/:id', authenticate, superAdminOnly, users.updateUser);
router.delete('/users/:id', authenticate, superAdminOnly, users.deleteUser);

// DASHBOARD
router.get('/dashboard', authenticate, dashboard.getDashboard);

// INVENTORY
router.get('/categories', authenticate, inventory.getCategories);
router.post('/categories', authenticate, authorize('super_admin', 'warehouse_staff'), inventory.createCategory);
router.get('/products', authenticate, inventory.getProducts);
router.get('/products/:id', authenticate, inventory.getProduct);
router.post('/products', authenticate, authorize('super_admin', 'warehouse_staff'), inventory.createProduct);
router.put('/products/:id', authenticate, authorize('super_admin', 'warehouse_staff'), inventory.updateProduct);
router.delete('/products/:id', authenticate, superAdminOnly, inventory.deleteProduct);
router.post('/products/:id/adjust-stock', authenticate, authorize('super_admin', 'warehouse_staff'), inventory.adjustStock);
router.get('/products/:id/movements', authenticate, inventory.getStockMovements);

// ORDERS
router.get('/orders', authenticate, orders.getOrders);
router.get('/orders/:id', authenticate, orders.getOrder);
router.post('/orders', authenticate, authorize('super_admin', 'sales_staff'), orders.createOrder);
router.patch('/orders/:id/status', authenticate, authorize('super_admin', 'sales_staff'), orders.updateOrderStatus);

// STOREFRONT
router.get('/storefront/products', orders.getStorefrontProducts);
router.post('/storefront/checkout', orders.initiateCheckout);
router.post('/storefront/verify-payment', orders.verifyPayment);
router.get('/storefront/orders/:orderNumber', async (req, res) => {
  const order = await Order.findOne({ order_number: req.params.orderNumber, source: 'storefront' })
    .select('order_number status payment_status customer_name delivery_address items total createdAt');
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  res.json({ success: true, data: order });
});

// STOREFRONT CART
const { Cart } = require('../models');

const getOrCreateCart = async (cart_id) => {
  if (cart_id) {
    const cart = await Cart.findOne({ cart_id });
    if (cart) return cart;
  }
  const newId = require('crypto').randomUUID();
  return await Cart.create({ cart_id: newId, items: [] });
};

router.get('/storefront/cart/:cartId', async (req, res) => {
  const cart = await Cart.findOne({ cart_id: req.params.cartId });
  if (!cart) return res.json({ success: true, data: { cart_id: req.params.cartId, items: [] } });
  res.json({ success: true, data: cart });
});

router.post('/storefront/cart/add', async (req, res) => {
  const { cart_id, product_id, quantity = 1 } = req.body;
  if (!product_id) return res.status(400).json({ success: false, message: 'product_id required.' });
  const product = await Product.findOne({ _id: product_id, is_active: true }).populate('category_id', 'name');
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });
  const cart = await getOrCreateCart(cart_id);
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

// SUPPLIERS
router.get('/suppliers', authenticate, async (req, res) => {
  const data = await Supplier.find({ is_active: true }).sort('name');
  res.json({ success: true, data });
});
router.post('/suppliers', authenticate, authorize('super_admin', 'procurement_officer'), async (req, res) => {
  const { name, email, phone, address, payment_terms, notes } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Supplier name is required.' });
  const data = await Supplier.create({ name, email, phone, address, payment_terms, notes });
  res.status(201).json({ success: true, data });
});
router.put('/suppliers/:id', authenticate, authorize('super_admin', 'procurement_officer'), async (req, res) => {
  const { name, email, phone, address, payment_terms, notes } = req.body;
  const data = await Supplier.findByIdAndUpdate(req.params.id, { name, email, phone, address, payment_terms, notes }, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Supplier not found.' });
  res.json({ success: true, data });
});
router.delete('/suppliers/:id', authenticate, authorize('super_admin', 'procurement_officer'), async (req, res) => {
  await Supplier.findByIdAndUpdate(req.params.id, { is_active: false });
  res.json({ success: true, message: 'Supplier deactivated.' });
});

// PURCHASE ORDERS
router.get('/purchase-orders', authenticate, async (req, res) => {
  const filter = {};
  if (req.query.status) {
    const statuses = req.query.status.split(',');
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  const data = await PurchaseOrder.find(filter).populate('supplier_id', 'name').sort({ createdAt: -1 });
  res.json({ success: true, data });
});
router.get('/purchase-orders/:id', authenticate, async (req, res) => {
  const po = await PurchaseOrder.findById(req.params.id).populate('supplier_id', 'name');
  if (!po) return res.status(404).json({ success: false, message: 'PO not found.' });
  res.json({ success: true, data: po });
});
router.post('/purchase-orders', authenticate, authorize('super_admin', 'procurement_officer'), async (req, res) => {
  const { supplier_id, expected_date, notes, items } = req.body;
  if (!supplier_id || !items?.length) return res.status(400).json({ success: false, message: 'supplier_id and items required.' });
  let total_cost = 0;
  const enriched = [];
  for (const item of items) {
    const p = await Product.findById(item.product_id);
    if (!p) return res.status(400).json({ success: false, message: 'Product not found.' });
    const itemTotal = parseFloat(item.unit_cost) * parseInt(item.quantity_ordered);
    total_cost += itemTotal;
    enriched.push({ product_id: p._id, product_name: p.name, quantity_ordered: item.quantity_ordered, unit_cost: item.unit_cost, total: itemTotal });
  }
  const po = await PurchaseOrder.create({ po_number: `PO-${Date.now()}`, supplier_id, total_cost, items: enriched, notes, expected_date: expected_date || null, created_by: req.user._id });
  res.status(201).json({ success: true, data: po });
});
router.patch('/purchase-orders/:id/approve', authenticate, authorize('super_admin', 'accountant'), async (req, res) => {
  const po = await PurchaseOrder.findByIdAndUpdate(req.params.id, { status: 'approved', approved_by: req.user._id, approved_at: new Date() }, { new: true });
  res.json({ success: true, data: po });
});
router.patch('/purchase-orders/:id/send', authenticate, authorize('super_admin', 'procurement_officer'), async (req, res) => {
  const po = await PurchaseOrder.findById(req.params.id);
  if (!po) return res.status(404).json({ success: false, message: 'PO not found.' });
  if (po.status !== 'approved') return res.status(400).json({ success: false, message: 'Only approved POs can be marked as sent.' });
  po.status = 'sent';
  await po.save();
  res.json({ success: true, data: po });
});
router.post('/purchase-orders/:id/receive', authenticate, authorize('super_admin', 'warehouse_staff', 'procurement_officer'), async (req, res) => {
  const { items } = req.body;
  const po = await PurchaseOrder.findById(req.params.id);
  if (!po) return res.status(404).json({ success: false, message: 'PO not found.' });
  for (const item of items) {
    if (!item.receive_qty || item.receive_qty <= 0) continue;
    const line = po.items.id(item._id);
    if (line) line.quantity_received += item.receive_qty;
    await Product.findByIdAndUpdate(item.product_id, { $inc: { stock_qty: item.receive_qty } });
    await StockMovement.create({ product_id: item.product_id, type: 'purchase', quantity: item.receive_qty, reference: po.po_number, created_by: req.user._id });
  }
  const allDone = po.items.every(i => i.quantity_received >= i.quantity_ordered);
  const anyDone = po.items.some(i => i.quantity_received > 0);
  po.status = allDone ? 'completed' : anyDone ? 'partially_received' : 'approved';
  await po.save();
  res.json({ success: true, message: 'Goods received.' });
});

// ACCOUNTING
router.get('/accounts', authenticate, async (req, res) => {
  const [accounts, jeBalances] = await Promise.all([
    Account.find({ is_active: true }).sort('code'),
    JournalEntry.aggregate([
      { $unwind: '$lines' },
      { $group: { _id: '$lines.account_id', balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
  ]);
  const jeMap = Object.fromEntries(jeBalances.map(b => [String(b._id), b.balance]));
  const data = accounts.map(a => ({ ...a.toJSON(), balance: jeMap[String(a._id)] || 0 }));
  res.json({ success: true, data });
});
router.post('/accounts', authenticate, authorize('super_admin', 'accountant'), async (req, res) => {
  const { code, name, type, description } = req.body;
  if (!code || !name || !type) return res.status(400).json({ success: false, message: 'code, name and type required.' });
  const exists = await Account.findOne({ code });
  if (exists) return res.status(400).json({ success: false, message: 'Account code already exists.' });
  const data = await Account.create({ code, name, type, description });
  res.status(201).json({ success: true, data });
});
router.put('/accounts/:id', authenticate, authorize('super_admin', 'accountant'), async (req, res) => {
  const { name, type, description } = req.body;
  const data = await Account.findByIdAndUpdate(req.params.id, { name, type, description }, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Account not found.' });
  res.json({ success: true, data });
});
router.get('/expenses', authenticate, async (req, res) => {
  const data = await Expense.find().populate('created_by', 'name').sort({ expense_date: -1 });
  res.json({ success: true, data });
});
router.post('/expenses', authenticate, authorize('super_admin', 'accountant'), async (req, res) => {
  const { title, category, amount, account_id, description, expense_date } = req.body;
  if (!title || !amount) return res.status(400).json({ success: false, message: 'title and amount required.' });
  const data = await Expense.create({ title, category, amount, account_id: account_id || null, description, expense_date: expense_date || Date.now(), created_by: req.user._id });
  res.status(201).json({ success: true, data });
});
router.put('/expenses/:id', authenticate, authorize('super_admin', 'accountant'), async (req, res) => {
  const { title, category, amount, account_id, description, expense_date } = req.body;
  const data = await Expense.findByIdAndUpdate(req.params.id, { title, category, amount, account_id: account_id || null, description, expense_date }, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Expense not found.' });
  res.json({ success: true, data });
});
router.delete('/expenses/:id', authenticate, authorize('super_admin', 'accountant'), async (req, res) => {
  await Expense.findByIdAndDelete(req.params.id);
  res.json({ success: true, message: 'Deleted.' });
});
router.get('/journal-entries', authenticate, async (req, res) => {
  const data = await JournalEntry.find().sort({ entry_date: -1 }).limit(100);
  res.json({ success: true, data });
});
router.post('/journal-entries', authenticate, authorize('super_admin', 'accountant'), async (req, res) => {
  const { description, entry_date, lines } = req.body;
  if (!description || !lines?.length) return res.status(400).json({ success: false, message: 'description and lines required.' });
  const total_debit = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
  const total_credit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const data = await JournalEntry.create({ reference: `JE-${Date.now()}`, description, total_debit, total_credit, entry_date: entry_date || Date.now(), lines, created_by: req.user._id });
  res.status(201).json({ success: true, data });
});
router.get('/accounting/balance-sheet', authenticate, async (req, res) => {
  const [revenueAgg, expensesAgg, arAgg, inventoryAgg, apAgg, jeBalances] = await Promise.all([
    Order.aggregate([{ $match: { payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' }, cogs: { $sum: '$subtotal' } } }]),
    Expense.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
    Order.aggregate([{ $match: { payment_status: 'pending' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Product.aggregate([{ $match: { is_active: true } }, { $group: { _id: null, total: { $sum: { $multiply: ['$cost_price', '$stock_qty'] } } } }]),
    PurchaseOrder.aggregate([{ $match: { status: { $in: ['approved','sent','partially_received'] } } }, { $group: { _id: null, total: { $sum: '$total_cost' } } }]),
    JournalEntry.aggregate([
      { $unwind: '$lines' },
      { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
      { $unwind: '$acc' },
      { $group: { _id: { id: '$acc._id', type: '$acc.type', code: '$acc.code' }, balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
  ]);

  const revenue      = revenueAgg[0]?.total || 0;
  const cogs         = revenueAgg[0]?.cogs  || 0;
  const totalExpenses = expensesAgg[0]?.total || 0;
  const ar           = arAgg[0]?.total       || 0;
  const inventory    = inventoryAgg[0]?.total || 0;
  const ap           = apAgg[0]?.total        || 0;

  // Cash = net of all journal lines on asset accounts with code 1001,
  // falling back to revenue - expenses - cogs if no journal entries exist
  const cashJe = jeBalances.find(b => b._id.code === '1001');
  const cash   = cashJe ? cashJe.balance : Math.max(0, revenue - totalExpenses);

  // Retained earnings = revenue - cogs - operating expenses (net profit)
  const retainedEarnings = revenue - cogs - totalExpenses;

  // Owner equity from journal lines on equity accounts
  const equityJe = jeBalances.filter(b => b._id.type === 'equity').reduce((s, b) => s - b.balance, 0);
  const totalEquity = equityJe + retainedEarnings;

  res.json({ success: true, data: {
    assets:      { cash: Math.max(0, cash), accounts_receivable: ar, inventory },
    liabilities: { accounts_payable: ap },
    equity:      { retained_earnings: retainedEarnings, owner_equity: equityJe, total: totalEquity },
  }});
});

router.get('/accounting/pl', authenticate, async (req, res) => {
  const match = { payment_status: 'paid' };
  const expMatch = {};
  if (req.query.from || req.query.to) {
    match.createdAt = {};
    expMatch.expense_date = {};
    if (req.query.from) { match.createdAt.$gte = new Date(req.query.from); expMatch.expense_date.$gte = new Date(req.query.from); }
    if (req.query.to)   { match.createdAt.$lte = new Date(req.query.to);   expMatch.expense_date.$lte = new Date(req.query.to); }
  }
  const [rev, cogs, expByCategory, monthly] = await Promise.all([
    Order.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$total' }, subtotal: { $sum: '$subtotal' } } }]),
    Order.aggregate([{ $match: match }, { $group: { _id: null, cogs: { $sum: '$subtotal' } } }]),
    Expense.aggregate([{ $match: expMatch }, { $group: { _id: { $ifNull: ['$category','Uncategorized'] }, total: { $sum: '$amount' } } }, { $sort: { total: -1 } }]),
    Order.aggregate([
      { $match: match },
      { $group: { _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } }, revenue: { $sum: '$total' } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      { $project: { month: { $arrayElemAt: [['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], '$_id.month'] }, year: '$_id.year', revenue: 1 } },
    ]),
  ]);
  const revenue = rev[0]?.total || 0;
  const totalExpenses = expByCategory.reduce((s, e) => s + e.total, 0);
  const grossProfit = revenue - (cogs[0]?.cogs || 0);
  const netProfit = revenue - totalExpenses;
  res.json({ success: true, data: {
    revenue, gross_profit: grossProfit, total_expenses: totalExpenses, net_profit: netProfit,
    expenses_by_category: expByCategory.map(e => ({ category: e._id, total: e.total })),
    monthly,
  }});
});

router.get('/accounting/summary', authenticate, async (req, res) => {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);

  const [rev, exp, monthlyRev, expByCategory, orders] = await Promise.all([
    Order.aggregate([{ $match: { payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Expense.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
    Order.aggregate([
      { $match: { payment_status: 'paid', createdAt: { $gte: yearStart } } },
      { $group: { _id: { month: { $month: '$createdAt' } }, revenue: { $sum: '$total' } } },
      { $sort: { '_id.month': 1 } },
      { $project: { month: { $arrayElemAt: [['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], '$_id.month'] }, revenue: 1 } },
    ]),
    Expense.aggregate([{ $group: { _id: { $ifNull: ['$category','Uncategorized'] }, total: { $sum: '$amount' } } }, { $sort: { total: -1 } }]),
    Order.aggregate([{ $match: { payment_status: 'paid' } }, { $group: { _id: null, cogs: { $sum: '$subtotal' } } }]),
  ]);

  const totalRevenue = rev[0]?.total || 0;
  const totalExpenses = exp[0]?.total || 0;
  const cogs = orders[0]?.cogs || 0;
  res.json({ success: true, data: {
    revenue: totalRevenue, expenses: totalExpenses, cogs,
    gross_profit: totalRevenue - cogs,
    net_profit: totalRevenue - totalExpenses,
    monthly_revenue: monthlyRev,
    expenses_by_category: expByCategory.map(e => ({ category: e._id, total: e.total })),
  }});
});

router.get('/accounting/gl/:accountId', authenticate, async (req, res) => {
  const account = await Account.findById(req.params.accountId);
  if (!account) return res.status(404).json({ success: false, message: 'Account not found.' });
  const entries = await JournalEntry.find({ 'lines.account_id': account._id }).sort({ entry_date: -1 }).limit(100);
  const lines = [];
  let running = 0;
  const sorted = [...entries].reverse();
  for (const entry of sorted) {
    for (const line of entry.lines) {
      if (String(line.account_id) === String(account._id)) {
        running += (line.debit || 0) - (line.credit || 0);
        lines.push({ date: entry.entry_date, reference: entry.reference, description: line.description || entry.description, debit: line.debit, credit: line.credit, balance: running });
      }
    }
  }
  res.json({ success: true, data: { account, lines: lines.reverse() } });
});

router.post('/accounting/reconcile', authenticate, async (req, res) => {
  const { lines } = req.body; // [{ date, description, amount }]
  if (!Array.isArray(lines) || !lines.length)
    return res.status(400).json({ success: false, message: 'lines array required.' });

  const cashAccount = await Account.findOne({ code: '1001' });
  if (!cashAccount) return res.status(404).json({ success: false, message: 'Cash & Bank account (1001) not found.' });

  const glEntries = await JournalEntry.find({ 'lines.account_id': cashAccount._id }).sort({ entry_date: 1 });
  const glLines = [];
  for (const entry of glEntries) {
    for (const line of entry.lines) {
      if (String(line.account_id) === String(cashAccount._id)) {
        const amount = (line.debit || 0) - (line.credit || 0);
        glLines.push({ id: String(line._id), date: entry.entry_date, description: line.description || entry.description, reference: entry.reference, amount });
      }
    }
  }

  const matched = [];
  const unmatchedBank = [];
  const usedGlIds = new Set();

  for (const bankLine of lines) {
    const bankAmt = parseFloat(bankLine.amount);
    const match = glLines.find(g =>
      !usedGlIds.has(g.id) &&
      Math.abs(g.amount - bankAmt) < 0.01
    );
    if (match) {
      usedGlIds.add(match.id);
      matched.push({ bank: bankLine, gl: match });
    } else {
      unmatchedBank.push(bankLine);
    }
  }

  const unmatchedGl = glLines.filter(g => !usedGlIds.has(g.id));
  const bankTotal = lines.reduce((s, l) => s + parseFloat(l.amount), 0);
  const glTotal   = glLines.reduce((s, l) => s + l.amount, 0);

  res.json({ success: true, data: { matched, unmatchedBank, unmatchedGl, bankTotal, glTotal, difference: bankTotal - glTotal, isBalanced: Math.abs(bankTotal - glTotal) < 0.01 } });
});

// TAX RATES
router.get('/tax-rates', authenticate, async (req, res) => {
  const data = await TaxRate.find().sort('name');
  res.json({ success: true, data });
});
router.post('/tax-rates', authenticate, authorize('super_admin', 'accountant'), async (req, res) => {
  const { name, rate, applies_to } = req.body;
  if (!name || rate === undefined) return res.status(400).json({ success: false, message: 'name and rate required.' });
  const data = await TaxRate.create({ name, rate, applies_to: applies_to || 'both' });
  res.status(201).json({ success: true, data });
});
router.put('/tax-rates/:id', authenticate, authorize('super_admin', 'accountant'), async (req, res) => {
  const { name, rate, applies_to, is_active } = req.body;
  const data = await TaxRate.findByIdAndUpdate(req.params.id, { name, rate, applies_to, is_active }, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Tax rate not found.' });
  res.json({ success: true, data });
});
router.delete('/tax-rates/:id', authenticate, authorize('super_admin', 'accountant'), async (req, res) => {
  await TaxRate.findByIdAndDelete(req.params.id);
  res.json({ success: true, message: 'Deleted.' });
});

router.get('/notifications', authenticate, async (req, res) => {
  const [lowStock, pendingLeave, pendingOrders, pendingPOs] = await Promise.all([
    Product.find({ is_active: true, $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] } }).sort('stock_qty').limit(5),
    LeaveRequest.find({ status: 'pending' }).populate('employee_id', 'name').sort({ createdAt: -1 }).limit(5),
    Order.find({ payment_status: 'pending' }).sort({ createdAt: -1 }).limit(5),
    PurchaseOrder.find({ status: 'pending_approval' }).sort({ createdAt: -1 }).limit(5),
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
router.get('/departments', authenticate, async (req, res) => {
  const data = await Department.find().sort('name');
  res.json({ success: true, data });
});
router.post('/departments', authenticate, authorize('super_admin', 'hr_manager'), async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'name required.' });
  const data = await Department.create({ name, description });
  res.status(201).json({ success: true, data });
});
router.put('/departments/:id', authenticate, authorize('super_admin', 'hr_manager'), async (req, res) => {
  const { name, description } = req.body;
  const data = await Department.findByIdAndUpdate(req.params.id, { name, description }, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Department not found.' });
  res.json({ success: true, data });
});

// EMPLOYEES
router.get('/employees', authenticate, async (req, res) => {
  const data = await Employee.find().populate('department_id', 'name').sort('name');
  const mapped = data.map(e => ({ ...e.toJSON(), department_name: e.department_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/employees', authenticate, authorize('super_admin', 'hr_manager'), async (req, res) => {
  const { name, email, phone, department_id, job_title, gross_salary, start_date, employee_code } = req.body;
  if (!name || !gross_salary) return res.status(400).json({ success: false, message: 'name and gross_salary required.' });
  const code = employee_code || `EMP-${Date.now().toString().slice(-6)}`;
  const data = await Employee.create({ employee_code: code, name, email, phone, department_id: department_id || null, job_title, gross_salary, start_date: start_date || null });
  res.status(201).json({ success: true, data });
});

// ATTENDANCE
router.get('/attendance', authenticate, async (req, res) => {
  const filter = {};
  if (req.query.date) filter.date = new Date(req.query.date);
  const data = await Attendance.find(filter).populate('employee_id', 'name').sort('employee_id');
  const mapped = data.map(a => ({ ...a.toJSON(), employee_name: a.employee_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/attendance', authenticate, authorize('super_admin', 'hr_manager'), async (req, res) => {
  const { employee_id, date, status, notes } = req.body;
  if (!employee_id || !date) return res.status(400).json({ success: false, message: 'employee_id and date required.' });
  const data = await Attendance.findOneAndUpdate(
    { employee_id, date: new Date(date) },
    { status: status || 'present', notes },
    { upsert: true, new: true }
  );
  res.status(201).json({ success: true, data });
});

// LEAVE REQUESTS
router.get('/leave-requests', authenticate, async (req, res) => {
  const data = await LeaveRequest.find().populate('employee_id', 'name').sort({ createdAt: -1 });
  const mapped = data.map(l => ({ ...l.toJSON(), employee_name: l.employee_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/leave-requests', authenticate, authorize('super_admin', 'hr_manager'), async (req, res) => {
  const { employee_id, leave_type, start_date, end_date, reason } = req.body;
  if (!employee_id || !start_date || !end_date) return res.status(400).json({ success: false, message: 'employee_id, start_date and end_date required.' });
  const data = await LeaveRequest.create({ employee_id, leave_type: leave_type || 'annual', start_date, end_date, reason });
  res.status(201).json({ success: true, data });
});
router.patch('/leave-requests/:id', authenticate, authorize('super_admin', 'hr_manager'), async (req, res) => {
  const data = await LeaveRequest.findByIdAndUpdate(req.params.id, { status: req.body.status, reviewed_by: req.user._id }, { new: true });
  res.json({ success: true, data });
});

// PAYROLL
router.get('/payroll', authenticate, async (req, res) => {
  const data = await PayrollRun.find().populate('employee_id', 'name').sort({ year: -1, month: -1 });
  const mapped = data.map(p => ({ ...p.toJSON(), employee_name: p.employee_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/payroll', authenticate, authorize('super_admin', 'hr_manager'), async (req, res) => {
  const { employee_id, month, year, allowances, deductions } = req.body;
  if (!employee_id) return res.status(400).json({ success: false, message: 'employee_id required.' });
  const emp = await Employee.findById(employee_id);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found.' });
  const gross = emp.gross_salary;
  const net = gross + parseFloat(allowances || 0) - parseFloat(deductions || 0);
  const data = await PayrollRun.create({ employee_id, month, year, gross_salary: gross, allowances: allowances || 0, deductions: deductions || 0, net_salary: net });
  res.status(201).json({ success: true, data });
});
router.patch('/payroll/:id/approve', authenticate, authorize('super_admin', 'accountant'), async (req, res) => {
  const data = await PayrollRun.findByIdAndUpdate(req.params.id, { status: 'approved', approved_by: req.user._id }, { new: true });
  res.json({ success: true, data });
});

// CRM - CUSTOMERS
router.get('/customers', authenticate, async (req, res) => {
  const data = await Customer.find().sort({ createdAt: -1 });
  res.json({ success: true, data });
});
router.post('/customers', authenticate, authorize('super_admin', 'sales_staff'), async (req, res) => {
  const { name, email, phone, company, address, segment, notes } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'name required.' });
  const data = await Customer.create({ name, email, phone, company, address, segment: segment || 'general', notes, created_by: req.user._id });
  res.status(201).json({ success: true, data });
});

// CRM - LEADS
router.get('/leads', authenticate, async (req, res) => {
  const data = await Lead.find().populate('customer_id', 'name').populate('assigned_to', 'name').sort({ createdAt: -1 });
  const mapped = data.map(l => ({ ...l.toJSON(), customer_name: l.customer_id?.name || null, assigned_to_name: l.assigned_to?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/leads', authenticate, authorize('super_admin', 'sales_staff'), async (req, res) => {
  const { customer_id, title, stage, value, assigned_to, notes, next_followup } = req.body;
  if (!title) return res.status(400).json({ success: false, message: 'title required.' });
  const data = await Lead.create({ customer_id: customer_id || null, title, stage: stage || 'new', value: value || 0, assigned_to: assigned_to || null, notes, next_followup: next_followup || null });
  res.status(201).json({ success: true, data });
});
router.patch('/leads/:id', authenticate, async (req, res) => {
  const { stage, value, notes, next_followup } = req.body;
  const update = {};
  if (stage !== undefined) update.stage = stage;
  if (value !== undefined) update.value = value;
  if (notes !== undefined) update.notes = notes;
  if (next_followup !== undefined) update.next_followup = next_followup;
  const data = await Lead.findByIdAndUpdate(req.params.id, update, { new: true });
  res.json({ success: true, data });
});

// CRM - CONTACT HISTORY
router.get('/contact-history', authenticate, async (req, res) => {
  const data = await ContactHistory.find().populate('customer_id', 'name').sort({ contact_date: -1, createdAt: -1 });
  const mapped = data.map(c => ({ ...c.toJSON(), customer_name: c.customer_id?.name || null }));
  res.json({ success: true, data: mapped });
});
router.post('/contact-history', authenticate, authorize('super_admin', 'sales_staff'), async (req, res) => {
  const { customer_id, type, notes, contact_date } = req.body;
  const data = await ContactHistory.create({ customer_id: customer_id || null, type: type || 'call', notes, contact_date: contact_date || Date.now(), created_by: req.user._id });
  res.status(201).json({ success: true, data });
});

// REPORTS
router.get('/reports/sales', authenticate, async (req, res) => {
  const match = { payment_status: 'paid' };
  if (req.query.from || req.query.to) {
    match.createdAt = {};
    if (req.query.from) match.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) match.createdAt.$lte = new Date(req.query.to);
  }
  const [summary, monthly, topProducts, byStatus] = await Promise.all([
    Order.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$total' }, count: { $sum: 1 }, avg: { $avg: '$total' } } }]),
    Order.aggregate([
      { $match: { payment_status: 'paid', createdAt: { $gte: new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000) } } },
      { $group: { _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      { $project: { month: { $arrayElemAt: [['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], '$_id.month'] }, revenue: 1, orders: 1 } },
    ]),
    Order.aggregate([
      { $match: match }, { $unwind: '$items' },
      { $group: { _id: '$items.product_id', name: { $first: '$items.product_name' }, units_sold: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' } } },
      { $sort: { revenue: -1 } }, { $limit: 6 },
    ]),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const by_status = {};
  byStatus.forEach(r => { by_status[r._id] = r.count; });
  const s = summary[0] || {};
  res.json({ success: true, data: { total_revenue: s.total || 0, total_orders: s.count || 0, avg_order_value: s.avg || 0, paid_orders: s.count || 0, monthly, top_products: topProducts, by_status } });
});

router.get('/reports/inventory', authenticate, async (req, res) => {
  const [products, valueAgg, lowStock, byCat] = await Promise.all([
    Product.find({ is_active: true }),
    Product.aggregate([{ $match: { is_active: true } }, { $group: { _id: null, total: { $sum: { $multiply: ['$cost_price', '$stock_qty'] } } } }]),
    Product.find({ is_active: true, $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] } }).sort('stock_qty').limit(10),
    Product.aggregate([
      { $match: { is_active: true } },
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

router.get('/reports/finance', authenticate, async (req, res) => {
  const [rev, exp, bycat] = await Promise.all([
    Order.aggregate([{ $match: { payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Expense.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
    Expense.aggregate([{ $group: { _id: { $ifNull: ['$category', 'Uncategorized'] }, total: { $sum: '$amount' } } }, { $sort: { total: -1 } }]),
  ]);
  res.json({ success: true, data: { revenue: rev[0]?.total || 0, total_expenses: exp[0]?.total || 0, expenses_by_category: bycat.map(c => ({ category: c._id, total: c.total })) } });
});

router.get('/reports/hr', authenticate, async (req, res) => {
  const now = new Date();
  const [employees, payroll, byDept] = await Promise.all([
    Employee.find(),
    PayrollRun.aggregate([{ $match: { month: now.getMonth() + 1, year: now.getFullYear(), status: 'approved' } }, { $group: { _id: null, total: { $sum: '$net_salary' } } }]),
    Employee.aggregate([
      { $match: { status: 'active' } },
      { $lookup: { from: 'departments', localField: 'department_id', foreignField: '_id', as: 'dept' } },
      { $group: { _id: { $arrayElemAt: ['$dept.name', 0] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);
  res.json({ success: true, data: {
    total_employees: employees.length,
    active: employees.filter(e => e.status === 'active').length,
    on_leave: employees.filter(e => e.status === 'on_leave').length,
    monthly_payroll: payroll[0]?.total || 0,
    by_department: byDept.map(d => ({ department: d._id, count: d.count })),
  }});
});

router.get('/reports/procurement', authenticate, async (req, res) => {
  const [pos, spend, bySupplier, recent] = await Promise.all([
    PurchaseOrder.find(),
    PurchaseOrder.aggregate([{ $group: { _id: null, total: { $sum: '$total_cost' } } }]),
    PurchaseOrder.aggregate([
      { $lookup: { from: 'suppliers', localField: 'supplier_id', foreignField: '_id', as: 'sup' } },
      { $group: { _id: { $arrayElemAt: ['$sup.name', 0] }, total: { $sum: '$total_cost' } } },
      { $sort: { total: -1 } }, { $limit: 8 },
    ]),
    PurchaseOrder.find().populate('supplier_id', 'name').sort({ createdAt: -1 }).limit(10),
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

router.get('/reports/crm', authenticate, async (req, res) => {
  const [customers, leads, byStage, topCust] = await Promise.all([
    Customer.countDocuments(),
    Lead.aggregate([{ $group: { _id: null, active: { $sum: { $cond: [{ $not: [{ $in: ['$stage', ['won', 'lost']] }] }, 1, 0] } }, won: { $sum: { $cond: [{ $eq: ['$stage', 'won'] }, 1, 0] } }, pipeline: { $sum: { $cond: [{ $not: [{ $in: ['$stage', ['won', 'lost']] }] }, '$value', 0] } } } }]),
    Lead.aggregate([{ $group: { _id: '$stage', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Customer.aggregate([
      { $lookup: { from: 'orders', localField: '_id', foreignField: 'customer_id', as: 'orders' } },
      { $addFields: { order_count: { $size: '$orders' } } },
      { $sort: { order_count: -1 } }, { $limit: 10 }, { $project: { orders: 0 } },
    ]),
  ]);
  const l = leads[0] || {};
  res.json({ success: true, data: { total_customers: customers, active_leads: l.active || 0, won_leads: l.won || 0, pipeline_value: l.pipeline || 0, by_stage: byStage.map(s => ({ stage: s._id, count: s.count })), top_customers: topCust } });
});

module.exports = router;
