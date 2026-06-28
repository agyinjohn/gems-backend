const express = require('express');
const router = express.Router();
const { authenticate, authorize, requireTenant } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureFlags');
const accounting = require('../services/accountingService');
const {
  Account, Expense, JournalEntry, TaxRate, Budget,
  Order, PurchaseOrder, PayrollRun,
  Invoice, CreditNote, AccountingPeriod, VendorBill, BankReconciliation,
} = require('../models');

router.use(requireFeature('accounting'));
router.use(authenticate);
router.use(requireTenant);

const CATEGORY_ACCOUNT_CODES = {
  office: '5200',
  rent: '5300',
  utilities: '5300',
  marketing: '5400',
  salaries: '5100',
  payroll: '5100',
  cogs: '5001',
  'bank charges': '5600',
  depreciation: '5500',
};

async function resolveExpenseAccountCode(tenantId, accountId, category) {
  if (accountId) {
    const acc = await Account.findOne({ _id: accountId, tenant_id: tenantId, is_active: true, is_group: false });
    if (acc) return acc.code;
  }
  const key = String(category || '').trim().toLowerCase();
  return CATEGORY_ACCOUNT_CODES[key] || '5900';
}

async function voidExpenseJournalEntry(expense, voidedBy, reason) {
  if (expense.journal_entry_id) {
    await accounting.voidJournalEntry(expense.journal_entry_id, expense.tenant_id, voidedBy, reason).catch(() => {});
    return;
  }
  const entry = await JournalEntry.findOne({
    tenant_id: expense.tenant_id,
    source: 'expense',
    source_id: expense._id,
    status: 'posted',
  });
  if (entry) await accounting.voidJournalEntry(entry._id, expense.tenant_id, voidedBy, reason).catch(() => {});
}

async function postExpenseToGl(expense, createdBy) {
  const accountCode = await resolveExpenseAccountCode(expense.tenant_id, expense.account_id, expense.category);
  const ref = `${String(expense._id)}-${Date.now()}`;
  const entry = await accounting.postExpenseEntry({
    tenantId: expense.tenant_id,
    amount: expense.amount,
    accountCode,
    reference: ref,
    date: expense.expense_date || new Date(),
    sourceId: expense._id,
    createdBy,
  });
  expense.journal_entry_id = entry._id;
  await expense.save();
  return entry;
}

async function cashAccountBalance(tid, asOfDate, before = false) {
  const cashAcc = await Account.findOne({ tenant_id: tid, code: '1001' });
  if (!cashAcc) return 0;
  const dateFilter = asOfDate ? (before ? { $lt: new Date(asOfDate) } : { $lte: new Date(asOfDate) }) : null;
  const match = { tenant_id: tid, status: { $ne: 'voided' } };
  if (dateFilter) match.entry_date = dateFilter;
  const agg = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.account_id': cashAcc._id } },
    { $group: { _id: null, balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
  ]);
  return agg[0]?.balance || 0;
}

async function glAccountActivity(tid, codes, from, to, direction = 'debit') {
  const accounts = await Account.find({ tenant_id: tid, code: { $in: codes } });
  if (!accounts.length) return { items: [], net: 0 };
  const ids = accounts.map((a) => a._id);
  const match = { tenant_id: tid, status: { $ne: 'voided' } };
  if (from || to) {
    match.entry_date = {};
    if (from) match.entry_date.$gte = new Date(from);
    if (to) match.entry_date.$lte = new Date(to);
  }
  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.account_id': { $in: ids } } },
    { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
    { $unwind: '$acc' },
    { $group: { _id: '$acc.code', name: { $first: '$acc.name' }, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const items = rows.map((r) => {
    const amount = direction === 'debit' ? r.debit - r.credit : r.credit - r.debit;
    return { label: r.name, code: r._id, amount };
  }).filter((i) => Math.abs(i.amount) > 0.001);
  const net = items.reduce((s, i) => s + i.amount, 0);
  return { items, net };
}

async function buildGlPl(tid, from, to) {
  return accounting.buildGlPl(tid, from, to);
}

// ACCOUNTING
// Trial Balance — GL-derived source of truth
router.get('/accounting/trial-balance', async (req, res) => {
  const tid = req.tenant_id;
  const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
  const [accounts, jeBalances] = await Promise.all([
    Account.find({ tenant_id: tid, is_active: true }).sort('code'),
    JournalEntry.aggregate([
      { $match: { tenant_id: tid, status: { $ne: 'voided' }, entry_date: { $lte: asOf } } },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.account_id', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]),
  ]);
  const balMap = Object.fromEntries(jeBalances.map(b => [String(b._id), b]));
  const rows = accounts.map(a => {
    const b = balMap[String(a._id)] || { debit: 0, credit: 0 };
    const net = b.debit - b.credit;
    const debitBalance  = ['asset','expense'].includes(a.type) ? Math.max(net, 0)  : Math.max(-net, 0);
    const creditBalance = ['asset','expense'].includes(a.type) ? Math.max(-net, 0) : Math.max(net, 0);
    return { code: a.code, name: a.name, type: a.type, debit_balance: debitBalance, credit_balance: creditBalance };
  });
  const totals = rows.reduce((s, r) => ({ debit: s.debit + r.debit_balance, credit: s.credit + r.credit_balance }), { debit: 0, credit: 0 });
  res.json({ success: true, data: { as_of: asOf, accounts: rows, totals } });
});

router.get('/accounts', async (req, res) => {
  if (req.query.view === 'coa') {
    const data = await accounting.buildAccountsCoaView(req.tenant_id, {
      include_groups: req.query.include_groups !== 'false',
      active_only: req.query.active_only !== 'false',
      type: req.query.type || null,
      search: req.query.search || '',
    });
    return res.json({ success: true, data });
  }

  const tid = req.tenant_id;
  const [accounts, jeBalances] = await Promise.all([
    Account.find({ tenant_id: tid, is_active: true }).sort('code'),
    JournalEntry.aggregate([
      { $match: { tenant_id: tid, status: { $ne: 'voided' } } },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.account_id', balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
  ]);
  const jeMap = Object.fromEntries(jeBalances.map((b) => [String(b._id), b.balance]));
  const data = accounts.map((a) => {
    const rawNet = jeMap[String(a._id)] || 0;
    return {
      ...a.toJSON(),
      balance: rawNet,
      display_balance: accounting.displayBalanceFromNet(a.type, rawNet),
    };
  });
  res.json({ success: true, data });
});

router.post('/accounts', authorize('business_owner', 'accountant'), async (req, res) => {
  const { code, name, type, description, opening_balance, parent_id } = req.body;
  if (!code || !name || !type) return res.status(400).json({ success: false, message: 'code, name and type required.' });
  if (!['asset', 'liability', 'equity', 'revenue', 'expense'].includes(type)) {
    return res.status(400).json({ success: false, message: 'Invalid account type.' });
  }
  const exists = await Account.findOne({ tenant_id: req.tenant_id, code: String(code).trim() });
  if (exists) return res.status(400).json({ success: false, message: 'Account code already exists.' });

  let parent = null;
  if (parent_id) {
    parent = await Account.findOne({ _id: parent_id, tenant_id: req.tenant_id, is_group: true });
    if (!parent) return res.status(400).json({ success: false, message: 'Parent group account not found.' });
  }

  const data = await Account.create({
    tenant_id: req.tenant_id,
    code: String(code).trim(),
    name: String(name).trim(),
    type,
    description: description || '',
    parent_id: parent?._id || null,
    level: parent ? (parent.level || 1) + 1 : 3,
    is_group: false,
    is_active: true,
  });

  const opening = parseFloat(opening_balance || 0);
  if (opening !== 0) {
    try {
      await accounting.postOpeningBalanceEntry(req.tenant_id, data, opening, req.user._id);
    } catch (err) {
      await Account.findByIdAndDelete(data._id);
      return res.status(400).json({ success: false, message: err.message || 'Failed to post opening balance.' });
    }
  }

  res.status(201).json({ success: true, data });
});

router.put('/accounts/:id', authorize('business_owner', 'accountant'), async (req, res) => {
  const { name, type, description, opening_balance } = req.body;
  const existing = await Account.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!existing) return res.status(404).json({ success: false, message: 'Account not found.' });
  if (existing.is_group) return res.status(400).json({ success: false, message: 'Group accounts cannot be edited here.' });

  const data = await Account.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    { name, type, description },
    { new: true },
  );

  if (opening_balance !== undefined && opening_balance !== null && opening_balance !== '') {
    const jeBalances = await JournalEntry.aggregate([
      { $match: { tenant_id: req.tenant_id, status: { $ne: 'voided' } } },
      { $unwind: '$lines' },
      { $match: { 'lines.account_id': existing._id } },
      { $group: { _id: null, balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]);
    const rawNet = jeBalances[0]?.balance || 0;
    const oldDisplayed = accounting.displayBalanceFromNet(existing.type, rawNet);
    const newDisplayed = parseFloat(opening_balance);
    const diff = round2(newDisplayed - oldDisplayed);
    if (Math.abs(diff) > 0.001) {
      try {
        await accounting.postBalanceAdjustmentEntry(req.tenant_id, data, diff, req.user._id);
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message || 'Balance adjustment failed.' });
      }
    }
  }

  res.json({ success: true, data });
});

router.patch('/accounts/:id/active', authorize('business_owner', 'accountant'), async (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ success: false, message: 'is_active boolean required.' });
  }

  const account = await Account.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!account) return res.status(404).json({ success: false, message: 'Account not found.' });

  if (!is_active) {
    const jeBalances = await JournalEntry.aggregate([
      { $match: { tenant_id: req.tenant_id, status: { $ne: 'voided' } } },
      { $unwind: '$lines' },
      { $match: { 'lines.account_id': account._id } },
      { $group: { _id: null, balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]);
    const displayed = accounting.displayBalanceFromNet(account.type, jeBalances[0]?.balance || 0);
    if (Math.abs(displayed) > 0.01) {
      return res.status(400).json({ success: false, message: 'Cannot deactivate an account with a non-zero balance.' });
    }
  }

  account.is_active = is_active;
  await account.save();
  res.json({ success: true, data: account });
});
router.get('/expenses', async (req, res) => {
  if (req.query.view === 'full') {
    const data = await accounting.buildExpensesView(req.tenant_id, {
      from: req.query.from || null,
      to: req.query.to || null,
      category: req.query.category || null,
      search: req.query.search || '',
    });
    return res.json({ success: true, data });
  }
  const data = await Expense.find({ tenant_id: req.tenant_id })
    .populate('created_by', 'name')
    .sort({ expense_date: -1 });
  res.json({ success: true, data });
});

router.post('/expenses', authorize('business_owner', 'accountant'), async (req, res) => {
  const { title, category, amount, account_id, description, expense_date, receipt } = req.body;
  if (!title || amount === undefined || amount === null || amount === '') {
    return res.status(400).json({ success: false, message: 'title and amount required.' });
  }
  const parsedAmount = parseFloat(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ success: false, message: 'amount must be greater than zero.' });
  }
  if (account_id) {
    const acc = await Account.findOne({
      _id: account_id,
      tenant_id: req.tenant_id,
      is_active: true,
      is_group: { $ne: true },
      type: 'expense',
    });
    if (!acc) return res.status(400).json({ success: false, message: 'Invalid expense GL account.' });
  }
  const data = await Expense.create({
    tenant_id: req.tenant_id,
    title: String(title).trim(),
    category: category || '',
    amount: parsedAmount,
    account_id: account_id || null,
    description: description || '',
    expense_date: expense_date || Date.now(),
    receipt: receipt || null,
    created_by: req.user._id,
  });
  try {
    await postExpenseToGl(data, req.user._id);
  } catch (err) {
    await Expense.findByIdAndDelete(data._id);
    return res.status(400).json({ success: false, message: err.message || 'Failed to post expense to ledger.' });
  }
  const populated = await Expense.findById(data._id)
    .populate('created_by', 'name')
    .populate('account_id', 'code name')
    .populate('journal_entry_id', 'reference status');
  res.status(201).json({ success: true, data: populated });
});
router.put('/expenses/:id', authorize('business_owner', 'accountant'), async (req, res) => {
  const { title, category, amount, account_id, description, expense_date, receipt } = req.body;
  const existing = await Expense.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!existing) return res.status(404).json({ success: false, message: 'Expense not found.' });
  const parsedAmount = parseFloat(amount);
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ success: false, message: 'amount must be greater than zero.' });
  }
  if (account_id) {
    const acc = await Account.findOne({
      _id: account_id,
      tenant_id: req.tenant_id,
      is_active: true,
      is_group: { $ne: true },
      type: 'expense',
    });
    if (!acc) return res.status(400).json({ success: false, message: 'Invalid expense GL account.' });
  }
  const update = {
    title: String(title || existing.title).trim(),
    category: category ?? existing.category,
    amount: parsedAmount,
    account_id: account_id || null,
    description: description ?? existing.description,
    expense_date: expense_date || existing.expense_date,
  };
  if (receipt !== undefined) update.receipt = receipt || null;
  await voidExpenseJournalEntry(existing, req.user._id, 'Expense updated');
  const data = await Expense.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    update,
    { new: true },
  );
  try {
    await postExpenseToGl(data, req.user._id);
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || 'Expense saved but ledger posting failed.' });
  }
  const populated = await Expense.findById(data._id)
    .populate('created_by', 'name')
    .populate('account_id', 'code name')
    .populate('journal_entry_id', 'reference status');
  res.json({ success: true, data: populated });
});
router.delete('/expenses/:id', authorize('business_owner', 'accountant'), async (req, res) => {
  const existing = await Expense.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!existing) return res.status(404).json({ success: false, message: 'Expense not found.' });
  await voidExpenseJournalEntry(existing, req.user._id, 'Expense deleted');
  await Expense.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant_id });
  res.json({ success: true, message: 'Deleted.' });
});
router.get('/journal-entries', async (req, res) => {
  try {
    if (req.query.view === 'full') {
      const data = await accounting.buildJournalView(req.tenant_id, {
        from: req.query.from,
        to: req.query.to,
        source: req.query.source,
        status: req.query.status,
        search: req.query.search,
      });
      return res.json({ success: true, data });
    }
    const data = await JournalEntry.find({ tenant_id: req.tenant_id }).sort({ entry_date: -1 }).limit(100);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/journal-entries/:id', async (req, res) => {
  try {
    const data = await accounting.buildJournalEntryDetail(req.tenant_id, req.params.id);
    if (!data) return res.status(404).json({ success: false, message: 'Journal entry not found.' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
router.post('/journal-entries', authorize('business_owner', 'accountant'), async (req, res) => {
  const { description, entry_date, lines } = req.body;
  if (!description || !lines?.length) return res.status(400).json({ success: false, message: 'description and lines required.' });
  const accountIds = lines.map((l) => l.account_id).filter(Boolean);
  const accounts = await Account.find({ tenant_id: req.tenant_id, _id: { $in: accountIds } });
  const idToCode = Object.fromEntries(accounts.map((a) => [String(a._id), a.code]));
  const mappedLines = lines.map((l) => {
    const accountCode = l.accountCode || idToCode[String(l.account_id)];
    if (!accountCode) throw new Error('Invalid account on journal line.');
    return { accountCode, debit: l.debit, credit: l.credit, description: l.description };
  });
  try {
    const data = await accounting.postJournalEntry({
      tenantId: req.tenant_id,
      description,
      date: entry_date ? new Date(entry_date) : new Date(),
      lines: mappedLines,
      source: 'manual',
      createdBy: req.user._id,
      reference: `JE-${Date.now()}`,
    });
    const detail = await accounting.buildJournalEntryDetail(req.tenant_id, data._id);
    res.status(201).json({ success: true, data: detail || data });
  } catch (err) {
    res.status(err.status || 400).json({ success: false, message: err.message });
  }
});

router.post('/journal-entries/:id/void', authorize('business_owner', 'accountant'), async (req, res) => {
  const reversal = await accounting.voidJournalEntry(req.params.id, req.tenant_id, req.user._id, req.body.reason);
  res.json({ success: true, data: reversal });
});
router.get('/accounting/cashflow', async (req, res) => {
  const { from, to, source } = req.query;
  if (source !== 'hybrid') {
    const data = await accounting.buildGlCashFlow(req.tenant_id, from, to);
    return res.json({ success: true, data });
  }
  const tid = req.tenant_id;
  const match = { tenant_id: tid };
  const expMatch = { tenant_id: tid };
  const poMatch = { tenant_id: tid, payment_status: 'paid' };
  const payrollMatch = { tenant_id: tid, status: 'approved' };
  if (from || to) {
    match.createdAt = {}; expMatch.expense_date = {}; poMatch.paid_at = {}; payrollMatch.createdAt = {};
    if (from) {
      const f = new Date(from);
      match.createdAt.$gte = f; expMatch.expense_date.$gte = f; poMatch.paid_at.$gte = f; payrollMatch.createdAt.$gte = f;
    }
    if (to) {
      const t = new Date(to);
      match.createdAt.$lte = t; expMatch.expense_date.$lte = t; poMatch.paid_at.$lte = t; payrollMatch.createdAt.$lte = t;
    }
  }
  const [salesAgg, expAgg, poAgg, payrollAgg, openingBalance, closingBalance, investing, financing] = await Promise.all([
    Order.aggregate([{ $match: { ...match, payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Expense.aggregate([{ $match: expMatch }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    PurchaseOrder.aggregate([{ $match: poMatch }, { $group: { _id: null, total: { $sum: '$total_cost' } } }]),
    PayrollRun.aggregate([{ $match: payrollMatch }, { $group: { _id: null, total: { $sum: '$net_salary' } } }]),
    cashAccountBalance(tid, from || null, true),
    cashAccountBalance(tid, to || new Date(), false),
    glAccountActivity(tid, ['1210'], from, to, 'debit'),
    glAccountActivity(tid, ['3001', '2210'], from, to, 'credit'),
  ]);
  const cashFromSales     =  salesAgg[0]?.total   || 0;
  const cashPaidExpenses  = -(expAgg[0]?.total     || 0);
  const cashPaidSuppliers = -(poAgg[0]?.total      || 0);
  const cashPaidPayroll   = -(payrollAgg[0]?.total || 0);
  const operatingNet = cashFromSales + cashPaidExpenses + cashPaidSuppliers + cashPaidPayroll;
  const netChange = closingBalance - openingBalance;
  res.json({ success: true, data: {
    operating: {
      cash_from_sales:     cashFromSales,
      cash_paid_expenses:  cashPaidExpenses,
      cash_paid_suppliers: cashPaidSuppliers,
      cash_paid_payroll:   cashPaidPayroll,
      net: operatingNet,
    },
    investing,
    financing,
    opening_balance: openingBalance,
    net_change:      netChange,
    closing_balance: closingBalance,
  }});
});

router.get('/accounting/balance-sheet', async (req, res) => {
  const tid = req.tenant_id;
  // Derive everything from the GL — no raw collection queries
  const jeBalances = await JournalEntry.aggregate([
    { $match: { tenant_id: tid, status: { $ne: 'voided' } } },
    { $unwind: '$lines' },
    { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
    { $unwind: '$acc' },
    { $group: {
      _id: { id: '$acc._id', type: '$acc.type', code: '$acc.code', name: '$acc.name' },
      debit:  { $sum: '$lines.debit' },
      credit: { $sum: '$lines.credit' },
    }},
  ]);

  const glMap = {};
  for (const b of jeBalances) {
    const net = b.debit - b.credit;
    glMap[b._id.code] = { type: b._id.type, name: b._id.name, net };
  }

  const gl = (code) => glMap[code]?.net || 0;

  // Assets
  const cash               = gl('1001');
  const accountsReceivable = gl('1110');
  const inventory          = gl('1120');
  const prepaid            = gl('1130');
  const vatInput           = gl('1135');
  const ppe                = gl('1210');
  const accumDepr          = gl('1220'); // normally negative (credit balance)
  const totalCurrentAssets    = cash + accountsReceivable + inventory + prepaid + vatInput;
  const totalNonCurrentAssets = ppe + accumDepr;
  const totalAssets           = totalCurrentAssets + totalNonCurrentAssets;

  // Liabilities
  const accountsPayable  = -(gl('2001')); // credit-normal: negate net
  const vatPayable       = -(gl('2110'));
  const accruedLiab      = -(gl('2120'));
  const salariesPayable  = -(gl('2130'));
  const longTermLoans    = -(gl('2210'));
  const totalCurrentLiab    = accountsPayable + vatPayable + accruedLiab + salariesPayable;
  const totalNonCurrentLiab = longTermLoans;
  const totalLiabilities    = totalCurrentLiab + totalNonCurrentLiab;

  // Equity
  const ownerEquity      = -(gl('3001'));
  const retainedEarnings = -(gl('3900'));
  // Compute current-period net income from revenue & expense accounts
  const revenueAccounts = jeBalances.filter(b => b._id.type === 'revenue');
  const expenseAccounts = jeBalances.filter(b => b._id.type === 'expense');
  const totalRevenue    = revenueAccounts.reduce((s, b) => s + (b.credit - b.debit), 0);
  const totalExpenses   = expenseAccounts.reduce((s, b) => s + (b.debit - b.credit), 0);
  const currentNetIncome = totalRevenue - totalExpenses;
  const totalEquity = ownerEquity + retainedEarnings + currentNetIncome;

  res.json({ success: true, data: {
    assets: {
      cash,
      accounts_receivable: accountsReceivable,
      inventory,
      prepaid,
      ppe,
      accum_depreciation: accumDepr,
      total_current:     totalCurrentAssets,
      total_non_current: totalNonCurrentAssets,
      total:             totalAssets,
    },
    liabilities: {
      accounts_payable:  accountsPayable,
      vat_payable:       vatPayable,
      accrued:           accruedLiab,
      salaries_payable:  salariesPayable,
      long_term_loans:   longTermLoans,
      total_current:     totalCurrentLiab,
      total_non_current: totalNonCurrentLiab,
      total:             totalLiabilities,
    },
    equity: {
      owner_equity:       ownerEquity,
      retained_earnings:  retainedEarnings,
      current_net_income: currentNetIncome,
      total:              totalEquity,
    },
    is_balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  }});
});

router.get('/accounting/vat-return', async (req, res) => {
  const tid = req.tenant_id;
  const match = { tenant_id: tid, status: { $ne: 'voided' } };
  if (req.query.from || req.query.to) {
    match.entry_date = {};
    if (req.query.from) match.entry_date.$gte = new Date(req.query.from);
    if (req.query.to)   match.entry_date.$lte = new Date(req.query.to);
  }
  const [vatPayable, vatInput] = await Promise.all([
    Account.findOne({ tenant_id: tid, code: '2110' }),
    Account.findOne({ tenant_id: tid, code: '1135' }),
  ]);
  if (!vatPayable) return res.status(404).json({ success: false, message: 'VAT Payable account (2110) not found.' });

  const [outputAgg, inputAgg] = await Promise.all([
    JournalEntry.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      { $match: { 'lines.account_id': vatPayable._id } },
      { $group: { _id: null, output_vat: { $sum: '$lines.credit' }, adjustments: { $sum: '$lines.debit' } } },
    ]),
    vatInput ? JournalEntry.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      { $match: { 'lines.account_id': vatInput._id } },
      { $group: { _id: null, input_vat: { $sum: '$lines.debit' }, reversals: { $sum: '$lines.credit' } } },
    ]) : [],
  ]);

  const output_vat = round2((outputAgg[0]?.output_vat || 0) - (outputAgg[0]?.adjustments || 0));
  const input_vat  = round2((inputAgg[0]?.input_vat || 0) - (inputAgg[0]?.reversals || 0));
  const net_vat_payable = round2(output_vat - input_vat);

  res.json({ success: true, data: {
    period: { from: req.query.from || null, to: req.query.to || null },
    output_vat,
    input_vat,
    net_vat_payable,
    status: net_vat_payable >= 0 ? 'payable' : 'reclaimable',
  }});
});

function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

router.get('/accounting/pl', async (req, res) => {
  const tid = req.tenant_id;
  const { from, to, source } = req.query;

  if (source === 'orders') {
  const match = { tenant_id: tid, payment_status: 'paid' };
  const expMatch = { tenant_id: tid };
  if (from || to) {
    match.createdAt = {}; expMatch.expense_date = {};
    if (from) { match.createdAt.$gte = new Date(from); expMatch.expense_date.$gte = new Date(from); }
    if (to)   { match.createdAt.$lte = new Date(to);   expMatch.expense_date.$lte = new Date(to); }
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
  res.json({ success: true, data: {
    source: 'orders',
    revenue, gross_profit: revenue - (cogs[0]?.cogs || 0), total_expenses: totalExpenses, net_profit: revenue - totalExpenses,
    expenses_by_category: expByCategory.map(e => ({ category: e._id, total: e.total })), monthly,
  }});
  }

  const data = await buildGlPl(tid, from, to);
  return res.json({ success: true, data });
});

router.get('/accounting/summary', async (req, res) => {
  const period = ['mtd', 'ytd', 'all'].includes(req.query.period) ? req.query.period : 'ytd';
  const data = await accounting.buildAccountingOverview(req.tenant_id, { period });
  res.json({ success: true, data });
});

router.get('/accounting/gl/:accountId', async (req, res) => {
  const data = await accounting.buildAccountLedger(req.tenant_id, req.params.accountId);
  if (!data) return res.status(404).json({ success: false, message: 'Account not found.' });
  res.json({ success: true, data });
});

router.post('/accounting/reconcile', async (req, res) => {
  try {
    const data = await accounting.executeBankReconciliation(req.tenant_id, {
      lines: req.body.lines,
      account_id: req.body.account_id,
      from: req.body.from,
      to: req.body.to,
      opening_balance: req.body.opening_balance,
      closing_balance: req.body.closing_balance,
      statement_date: req.body.statement_date,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.get('/accounting/reconciliation', async (req, res) => {
  try {
    const data = await accounting.buildReconciliationView(req.tenant_id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// AP LEDGER — GL-derived accounts payable
router.get('/accounting/ap-ledger', async (req, res) => {
  try {
    if (req.query.view === 'full') {
      const data = await accounting.buildPayablesView(req.tenant_id, {
        search: req.query.search,
        source: req.query.source,
        aging_bucket: req.query.aging_bucket,
      });
      return res.json({ success: true, data });
    }
    const data = await accounting.buildPayablesView(req.tenant_id, {});
    res.json({ success: true, data: { entries: data.entries, total_outstanding: data.summary.total_outstanding } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/accounting/receivables', async (req, res) => {
  try {
    const data = await accounting.buildReceivablesView(req.tenant_id, {
      search: req.query.search,
      status: req.query.status,
      aging_bucket: req.query.aging_bucket,
      customer_id: req.query.customer_id,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/accounting/payables', async (req, res) => {
  try {
    const data = await accounting.buildPayablesView(req.tenant_id, {
      search: req.query.search,
      source: req.query.source,
      aging_bucket: req.query.aging_bucket,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// BUDGETS
router.get('/budgets', async (req, res) => {
  const { period, period_type } = req.query;
  const filter = { tenant_id: req.tenant_id };
  if (period) filter.period = period;
  if (period_type) filter.period_type = period_type;
  const data = await Budget.find(filter).sort('category');
  res.json({ success: true, data });
});
router.post('/budgets', authorize('business_owner','accountant'), async (req, res) => {
  const { category, period, period_type, amount } = req.body;
  if (!category || !period || !amount) return res.status(400).json({ success: false, message: 'category, period and amount required.' });
  const data = await Budget.findOneAndUpdate(
    { tenant_id: req.tenant_id, category, period },
    { amount, period_type: period_type || 'monthly' },
    { upsert: true, new: true }
  );
  res.status(201).json({ success: true, data });
});
router.put('/budgets/:id', authorize('business_owner','accountant'), async (req, res) => {
  const { amount } = req.body;
  const data = await Budget.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { amount }, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Budget not found.' });
  res.json({ success: true, data });
});
router.delete('/budgets/:id', authorize('business_owner','accountant'), async (req, res) => {
  await Budget.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant_id });
  res.json({ success: true, message: 'Deleted.' });
});
router.get('/budgets/vs-actual', async (req, res) => {
  const tid = req.tenant_id;
  const { period, period_type = 'monthly' } = req.query;
  // Default period = current month (YYYY-MM) or year (YYYY)
  const now = new Date();
  const defaultPeriod = period_type === 'annual'
    ? String(now.getFullYear())
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const activePeriod = period || defaultPeriod;

  // Date range from period
  let fromDate, toDate;
  if (period_type === 'annual') {
    fromDate = new Date(`${activePeriod}-01-01`);
    toDate   = new Date(`${activePeriod}-12-31T23:59:59`);
  } else {
    const [y, m] = activePeriod.split('-').map(Number);
    fromDate = new Date(y, m - 1, 1);
    toDate   = new Date(y, m, 0, 23, 59, 59);
  }

  const [budgets, actuals] = await Promise.all([
    Budget.find({ tenant_id: tid, period: activePeriod, period_type }),
    Expense.aggregate([
      { $match: { tenant_id: tid, expense_date: { $gte: fromDate, $lte: toDate } } },
      { $group: { _id: { $ifNull: ['$category', 'Uncategorized'] }, actual: { $sum: '$amount' } } },
    ]),
  ]);

  const actualMap = Object.fromEntries(actuals.map(a => [a._id, a.actual]));
  // Merge: all budgeted categories + any actual-only categories
  const allCategories = new Set([
    ...budgets.map(b => b.category),
    ...actuals.map(a => a._id),
  ]);
  const rows = Array.from(allCategories).map(cat => {
    const budget = budgets.find(b => b.category === cat);
    const actual = actualMap[cat] || 0;
    const budgeted = budget?.amount || 0;
    const variance = budgeted - actual;
    const pct = budgeted > 0 ? (actual / budgeted) * 100 : null;
    return { category: cat, budgeted, actual, variance, pct, budget_id: budget?.id || null };
  }).sort((a, b) => a.category.localeCompare(b.category));

  const totals = rows.reduce((s, r) => ({ budgeted: s.budgeted + r.budgeted, actual: s.actual + r.actual, variance: s.variance + r.variance }), { budgeted: 0, actual: 0, variance: 0 });
  res.json({ success: true, data: { period: activePeriod, period_type, rows, totals } });
});

// TAX RATES
router.get('/tax-rates', async (req, res) => {
  const data = await TaxRate.find({ tenant_id: req.tenant_id }).sort('name');
  res.json({ success: true, data });
});
router.post('/tax-rates', authorize('business_owner', 'accountant'), async (req, res) => {
  const { name, rate, applies_to } = req.body;
  if (!name || rate === undefined) return res.status(400).json({ success: false, message: 'name and rate required.' });
  const data = await TaxRate.create({ tenant_id: req.tenant_id, name, rate, applies_to: applies_to || 'both' });
  res.status(201).json({ success: true, data });
});
router.put('/tax-rates/:id', authorize('business_owner', 'accountant'), async (req, res) => {
  const { name, rate, applies_to, is_active } = req.body;
  const data = await TaxRate.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { name, rate, applies_to, is_active }, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Tax rate not found.' });
  res.json({ success: true, data });
});
router.delete('/tax-rates/:id', authorize('business_owner', 'accountant'), async (req, res) => {
  await TaxRate.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant_id });
  res.json({ success: true, message: 'Deleted.' });
});

// INVOICES
const invoiceNumber = (n) => `INV-${String(n).padStart(5, '0')}`;
const creditNoteNumber = (n) => `CN-${String(n).padStart(5, '0')}`;

router.get('/invoices', async (req, res) => {
  const { status, customer_id, from, to } = req.query;
  const filter = { tenant_id: req.tenant_id };
  if (status) {
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (customer_id) filter.customer_id = customer_id;
  if (from || to) {
    filter.issue_date = {};
    if (from) filter.issue_date.$gte = new Date(from);
    if (to)   filter.issue_date.$lte = new Date(to);
  }
  // Auto-mark overdue
  await Invoice.updateMany(
    { tenant_id: req.tenant_id, status: { $in: ['sent','partially_paid'] }, due_date: { $lt: new Date() } },
    { status: 'overdue' }
  );
  const data = await Invoice.find(filter).sort({ issue_date: -1 });
  res.json({ success: true, data });
});

router.get('/invoices/:id', async (req, res) => {
  const data = await Invoice.findOne({ _id: req.params.id, tenant_id: req.tenant_id }).populate('customer_id', 'name email phone');
  if (!data) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  res.json({ success: true, data });
});

router.post('/invoices', authorize('business_owner', 'accountant', 'sales_staff'), async (req, res) => {
  const { customer_id, customer_name, customer_email, issue_date, due_date, lines, notes, order_id } = req.body;
  if (!customer_name || !due_date || !lines?.length) return res.status(400).json({ success: false, message: 'customer_name, due_date and lines required.' });

  let subtotal = 0, tax_amount = 0;
  const enrichedLines = lines.map(l => {
    const lineTotal = parseFloat(l.quantity) * parseFloat(l.unit_price);
    const lineTax   = lineTotal * (parseFloat(l.tax_rate || 0) / 100);
    subtotal   += lineTotal;
    tax_amount += lineTax;
    return { ...l, total: lineTotal + lineTax };
  });
  const total = subtotal + tax_amount;

  const count = await Invoice.countDocuments({ tenant_id: req.tenant_id });
  const inv = await Invoice.create({
    tenant_id: req.tenant_id,
    invoice_number: invoiceNumber(count + 1),
    customer_id: customer_id || null,
    customer_name, customer_email,
    issue_date: issue_date || new Date(),
    due_date: new Date(due_date),
    lines: enrichedLines,
    subtotal, tax_amount, total,
    amount_paid: 0, amount_due: total,
    status: 'draft',
    notes, order_id: order_id || null,
    created_by: req.user._id,
  });
  res.status(201).json({ success: true, data: inv });
});

router.patch('/invoices/:id/send', authorize('business_owner', 'accountant', 'sales_staff'), async (req, res) => {
  const inv = await Invoice.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  if (inv.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft invoices can be sent.' });
  inv.status = 'sent';
  const entry = await accounting.postSaleEntry({
    tenantId: req.tenant_id, amount: inv.total, cogsAmount: 0,
    taxAmount: inv.tax_amount, reference: inv.invoice_number,
    date: inv.issue_date, sourceId: inv._id, createdBy: req.user._id, isCredit: true,
  });
  inv.journal_entry_id = entry._id;
  await inv.save();
  res.json({ success: true, data: inv });
});

router.post('/invoices/:id/payments', authorize('business_owner', 'accountant'), async (req, res) => {
  const { amount, method, reference, note, date } = req.body;
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ success: false, message: 'amount required.' });

  const inv = await Invoice.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  if (inv.status === 'paid' || inv.status === 'void') return res.status(400).json({ success: false, message: `Invoice is ${inv.status}.` });

  const paying = Math.min(parseFloat(amount), inv.amount_due);
  inv.payments.push({ amount: paying, method: method || 'cash', reference, note, date: date ? new Date(date) : new Date() });
  inv.amount_paid += paying;
  inv.amount_due   = inv.total - inv.amount_paid;
  inv.status = inv.amount_due <= 0.01 ? 'paid' : 'partially_paid';
  await inv.save();

  // Post GL: Dr Cash & Bank / Cr Accounts Receivable
  await accounting.postSalePaymentEntry({
    tenantId: req.tenant_id, amount: paying,
    reference: inv.invoice_number, date: new Date(),
    sourceId: inv._id, createdBy: req.user._id,
  }).catch(() => {});

  res.json({ success: true, data: inv });
});

router.patch('/invoices/:id/void', authorize('business_owner', 'accountant'), async (req, res) => {
  const inv = await Invoice.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  if (inv.status === 'paid') return res.status(400).json({ success: false, message: 'Cannot void a paid invoice. Issue a credit note instead.' });
  if (['sent', 'partially_paid', 'overdue'].includes(inv.status)) {
    await accounting.voidJournalEntriesBySource(req.tenant_id, 'sale', inv._id, req.user._id, `Invoice ${inv.invoice_number} voided`);
  }
  inv.status = 'void';
  await inv.save();
  res.json({ success: true, data: inv });
});

// CREDIT NOTES
router.get('/credit-notes', async (req, res) => {
  try {
    if (req.query.view === 'full') {
      const data = await accounting.buildCreditNotesView(req.tenant_id, {
        search: req.query.search,
        status: req.query.status,
      });
      return res.json({ success: true, data });
    }
    const data = await CreditNote.find({ tenant_id: req.tenant_id }).populate('invoice_id', 'invoice_number').sort({ createdAt: -1 });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/credit-notes', authorize('business_owner', 'accountant'), async (req, res) => {
  const { invoice_id, amount, reason } = req.body;
  if (!invoice_id || !amount || !reason) return res.status(400).json({ success: false, message: 'invoice_id, amount and reason required.' });

  const inv = await Invoice.findOne({ _id: invoice_id, tenant_id: req.tenant_id });
  if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  if (inv.status === 'void') return res.status(400).json({ success: false, message: 'Cannot credit a voided invoice.' });

  const creditAmt = Math.min(parseFloat(amount), inv.amount_paid);
  const count = await CreditNote.countDocuments({ tenant_id: req.tenant_id });
  const cn = await CreditNote.create({
    tenant_id: req.tenant_id,
    credit_note_number: creditNoteNumber(count + 1),
    invoice_id: inv._id,
    customer_id: inv.customer_id,
    customer_name: inv.customer_name,
    amount: creditAmt,
    reason,
    status: 'applied',
    created_by: req.user._id,
  });

  // Reverse the payment on the invoice
  inv.amount_paid = Math.max(0, inv.amount_paid - creditAmt);
  inv.amount_due  = inv.total - inv.amount_paid;
  inv.status = inv.amount_paid <= 0.01 ? 'sent' : 'partially_paid';
  await inv.save();

  const taxPortion = inv.total > 0 ? round2((creditAmt / inv.total) * inv.tax_amount) : 0;
  await accounting.postCreditNoteEntry({
    tenantId: req.tenant_id,
    amount: creditAmt,
    taxAmount: taxPortion,
    reference: cn.credit_note_number,
    date: new Date(),
    sourceId: cn._id,
    createdBy: req.user._id,
    refundToCash: true,
  });

  res.status(201).json({ success: true, data: cn });
});

// ACCOUNTING PERIODS
router.get('/accounting/periods', async (req, res) => {
  const data = await AccountingPeriod.find({ tenant_id: req.tenant_id }).sort({ start_date: -1 });
  res.json({ success: true, data });
});

router.post('/accounting/periods', authorize('business_owner', 'accountant'), async (req, res) => {
  const { name, type, start_date, end_date } = req.body;
  if (!name || !start_date || !end_date) return res.status(400).json({ success: false, message: 'name, start_date and end_date required.' });
  // Prevent overlapping open periods
  const overlap = await AccountingPeriod.findOne({
    tenant_id: req.tenant_id,
    status: 'open',
    $or: [
      { start_date: { $lte: new Date(end_date) }, end_date: { $gte: new Date(start_date) } },
    ],
  });
  if (overlap) return res.status(400).json({ success: false, message: `Overlaps with existing open period: ${overlap.name}` });
  const data = await AccountingPeriod.create({
    tenant_id: req.tenant_id,
    name, type: type || 'month',
    start_date: new Date(start_date),
    end_date:   new Date(end_date),
    status: 'open',
  });
  res.status(201).json({ success: true, data });
});

router.patch('/accounting/periods/:id/close', authorize('business_owner', 'accountant'), async (req, res) => {
  const period = await AccountingPeriod.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!period) return res.status(404).json({ success: false, message: 'Period not found.' });
  if (period.status === 'closed') return res.status(400).json({ success: false, message: 'Period is already closed.' });

  // Check for unbalanced journal entries in this period
  const unbalanced = await JournalEntry.findOne({
    tenant_id: req.tenant_id,
    status: 'posted',
    entry_date: { $gte: period.start_date, $lte: period.end_date },
    $expr: { $gt: [{ $abs: { $subtract: ['$total_debit', '$total_credit'] } }, 0.01] },
  });
  if (unbalanced) return res.status(400).json({ success: false, message: `Cannot close period: unbalanced entry ${unbalanced.reference} exists.` });

  period.status    = 'closed';
  period.closed_by = req.user._id;
  period.closed_at = new Date();
  await period.save();
  res.json({ success: true, data: period });
});

router.patch('/accounting/periods/:id/reopen', authorize('business_owner'), async (req, res) => {
  const period = await AccountingPeriod.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!period) return res.status(404).json({ success: false, message: 'Period not found.' });
  if (period.status === 'open') return res.status(400).json({ success: false, message: 'Period is already open.' });
  period.status    = 'open';
  period.closed_by = undefined;
  period.closed_at = undefined;
  await period.save();
  res.json({ success: true, data: period });
});

// Year-end closing — zeros out revenue & expense accounts into Retained Earnings
router.post('/accounting/periods/:id/year-end-close', authorize('business_owner', 'accountant'), async (req, res) => {
  const period = await AccountingPeriod.findOne({ _id: req.params.id, tenant_id: req.tenant_id, type: 'year' });
  if (!period) return res.status(404).json({ success: false, message: 'Annual period not found.' });
  if (period.status !== 'closed') return res.status(400).json({ success: false, message: 'Period must be closed before year-end closing entries can be posted.' });

  // Check no closing entry already posted for this period
  const alreadyDone = await JournalEntry.findOne({
    tenant_id: req.tenant_id,
    reference: `YEC-${period._id}`,
  });
  if (alreadyDone) return res.status(400).json({ success: false, message: 'Year-end closing entries already posted for this period.' });

  // Aggregate revenue and expense account balances for the period
  const jeBalances = await JournalEntry.aggregate([
    { $match: { tenant_id: req.tenant_id, status: { $ne: 'voided' }, entry_date: { $gte: period.start_date, $lte: period.end_date } } },
    { $unwind: '$lines' },
    { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
    { $unwind: '$acc' },
    { $match: { 'acc.type': { $in: ['revenue', 'expense'] } } },
    { $group: {
      _id: { id: '$acc._id', type: '$acc.type', code: '$acc.code' },
      debit:  { $sum: '$lines.debit' },
      credit: { $sum: '$lines.credit' },
    }},
  ]);

  if (!jeBalances.length) return res.status(400).json({ success: false, message: 'No revenue or expense entries found in this period.' });

  // Build closing lines — reverse each revenue/expense account to zero it out
  const closingLines = [];
  let netIncome = 0;

  for (const b of jeBalances) {
    const net = b.debit - b.credit;
    if (Math.abs(net) < 0.01) continue;
    if (b._id.type === 'revenue') {
      // Revenue has credit balance (net < 0) — debit to close
      closingLines.push({ account_id: b._id.id, debit: Math.abs(net), credit: 0, description: `Close revenue: ${b._id.code}` });
      netIncome += Math.abs(net);
    } else {
      // Expense has debit balance (net > 0) — credit to close
      closingLines.push({ account_id: b._id.id, debit: 0, credit: net, description: `Close expense: ${b._id.code}` });
      netIncome -= net;
    }
  }

  // Offset goes to Retained Earnings (3900)
  const retainedAcc = await Account.findOne({ tenant_id: req.tenant_id, code: '3900' });
  if (!retainedAcc) return res.status(400).json({ success: false, message: 'Retained Earnings account (3900) not found.' });

  if (netIncome >= 0) {
    closingLines.push({ account_id: retainedAcc._id, debit: 0, credit: netIncome, description: 'Net income transferred to Retained Earnings' });
  } else {
    closingLines.push({ account_id: retainedAcc._id, debit: Math.abs(netIncome), credit: 0, description: 'Net loss transferred to Retained Earnings' });
  }

  const total_debit  = closingLines.reduce((s, l) => s + l.debit,  0);
  const total_credit = closingLines.reduce((s, l) => s + l.credit, 0);

  const entry = await JournalEntry.create({
    tenant_id:    req.tenant_id,
    reference:    `YEC-${period._id}`,
    description:  `Year-end closing entries — ${period.name}`,
    total_debit,
    total_credit,
    entry_date:   period.end_date,
    lines:        closingLines,
    source:       'manual',
    created_by:   req.user._id,
    status:       'posted',
  });

  res.json({ success: true, message: `Year-end closing posted. Net income: GHS ${netIncome.toFixed(2)}`, data: entry });
});

// Block posting to closed periods — redundant with service check; kept for early validation on manual JE route
router.use('/journal-entries', async (req, res, next) => {
  if (req.method !== 'POST' || !req.tenant_id) return next();
  try {
    await accounting.assertPeriodOpen(req.tenant_id, req.body?.entry_date);
    next();
  } catch (err) {
    res.status(err.status || 400).json({ success: false, message: err.message });
  }
});

// Manual CSV/JSON import for standalone accounting deployments
router.post('/accounting/import', authorize('business_owner', 'accountant'), async (req, res) => {
  const { type, rows } = req.body;
  if (!type || !Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ success: false, message: 'type and rows[] required.' });
  }

  if (type === 'expenses') {
    let imported = 0;
    const errors = [];
    for (const row of rows) {
      try {
        const title = row.title || row.name;
        const amount = parseFloat(row.amount);
        if (!title || !amount) continue;
        const expense = await Expense.create({
          tenant_id: req.tenant_id,
          title: String(title).trim(),
          category: row.category ? String(row.category).trim() : '',
          amount,
          description: row.description || '',
          expense_date: row.expense_date ? new Date(row.expense_date) : new Date(),
          created_by: req.user._id,
        });
        await postExpenseToGl(expense, req.user._id);
        imported += 1;
      } catch (err) {
        errors.push(err.message || 'Row failed');
      }
    }
    return res.json({ success: true, data: { imported, errors: errors.slice(0, 5) } });
  }

  if (type === 'journal') {
    let imported = 0;
    const errors = [];
    const grouped = {};
    for (const row of rows) {
      const key = row.reference || row.description || `IMPORT-${Date.now()}`;
      if (!grouped[key]) grouped[key] = { description: row.description || key, entry_date: row.entry_date, lines: [] };
      grouped[key].lines.push({
        accountCode: row.account_code || row.accountCode,
        debit: parseFloat(row.debit) || 0,
        credit: parseFloat(row.credit) || 0,
        description: row.line_description || row.description || '',
      });
    }
    for (const entry of Object.values(grouped)) {
      try {
        await accounting.postJournalEntry({
          tenantId: req.tenant_id,
          description: entry.description,
          date: entry.entry_date ? new Date(entry.entry_date) : new Date(),
          lines: entry.lines,
          source: 'manual',
          createdBy: req.user._id,
          reference: `IMP-${Date.now()}-${imported}`,
        });
        imported += 1;
      } catch (err) {
        errors.push(err.message || 'Entry failed');
      }
    }
    return res.json({ success: true, data: { imported, errors: errors.slice(0, 5) } });
  }

  return res.status(400).json({ success: false, message: 'type must be "expenses" or "journal".' });
});

function escapeCsv(val) {
  const s = String(val ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}

function journalRowsForExport(entries, accountsById) {
  const rows = [];
  for (const entry of entries) {
    for (const line of entry.lines || []) {
      const acc = accountsById.get(String(line.account_id));
      rows.push({
        date: entry.entry_date,
        reference: entry.reference,
        description: line.description || entry.description,
        account_code: acc?.code || '',
        account_name: acc?.name || '',
        debit: line.debit || 0,
        credit: line.credit || 0,
      });
    }
  }
  return rows;
}

router.get('/accounting/export/quickbooks', authorize('business_owner', 'accountant'), async (req, res) => {
  const { from, to } = req.query;
  const filter = { tenant_id: req.tenant_id, status: { $ne: 'voided' } };
  if (from || to) {
    filter.entry_date = {};
    if (from) filter.entry_date.$gte = new Date(from);
    if (to) filter.entry_date.$lte = new Date(to);
  }
  const [entries, accounts] = await Promise.all([
    JournalEntry.find(filter).sort({ entry_date: 1 }),
    Account.find({ tenant_id: req.tenant_id }),
  ]);
  const accountsById = new Map(accounts.map((a) => [String(a._id), a]));
  const rows = journalRowsForExport(entries, accountsById);
  const header = ['Date', 'Transaction Type', 'Num', 'Account', 'Debit', 'Credit', 'Memo'];
  const csvLines = [header.join(',')];
  for (const r of rows) {
    csvLines.push([
      escapeCsv(r.date ? new Date(r.date).toISOString().slice(0, 10) : ''),
      escapeCsv('Journal Entry'),
      escapeCsv(r.reference),
      escapeCsv(`${r.account_code} ${r.account_name}`.trim()),
      r.debit || '',
      r.credit || '',
      escapeCsv(r.description),
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="quickbooks-export-${Date.now()}.csv"`);
  res.send(csvLines.join('\n'));
});

router.get('/accounting/export/xero', authorize('business_owner', 'accountant'), async (req, res) => {
  const { from, to } = req.query;
  const filter = { tenant_id: req.tenant_id, status: { $ne: 'voided' } };
  if (from || to) {
    filter.entry_date = {};
    if (from) filter.entry_date.$gte = new Date(from);
    if (to) filter.entry_date.$lte = new Date(to);
  }
  const [entries, accounts] = await Promise.all([
    JournalEntry.find(filter).sort({ entry_date: 1 }),
    Account.find({ tenant_id: req.tenant_id }),
  ]);
  const accountsById = new Map(accounts.map((a) => [String(a._id), a]));
  const rows = journalRowsForExport(entries, accountsById);
  const header = ['*Date', '*Amount', 'Payee', 'Description', 'Reference', 'AccountCode'];
  const csvLines = [header.join(',')];
  for (const r of rows) {
    const amount = (r.debit || 0) - (r.credit || 0);
    csvLines.push([
      escapeCsv(r.date ? new Date(r.date).toISOString().slice(0, 10) : ''),
      amount.toFixed(2),
      escapeCsv('GEMS Export'),
      escapeCsv(r.description),
      escapeCsv(r.reference),
      escapeCsv(r.account_code),
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="xero-export-${Date.now()}.csv"`);
  res.send(csvLines.join('\n'));
});

router.post('/accounting/reconcile/import', authorize('business_owner', 'accountant'), async (req, res) => {
  try {
    const lines = accounting.normalizeBankLines(req.body.rows);
    if (!lines.length) return res.status(400).json({ success: false, message: 'No valid rows with amount.' });
    const data = await accounting.executeBankReconciliation(req.tenant_id, {
      lines,
      account_id: req.body.account_id,
      from: req.body.from,
      to: req.body.to,
      opening_balance: req.body.opening_balance,
      closing_balance: req.body.closing_balance,
      statement_date: req.body.statement_date,
    });
    res.json({ success: true, data: { ...data, imported: lines.length } });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});


// VENDOR BILLS (AP without PO)
const billNumber = (n) => `BILL-${String(n).padStart(5, '0')}`;

router.get('/vendor-bills', async (req, res) => {
  try {
    if (req.query.view === 'full') {
      const data = await accounting.buildVendorBillsView(req.tenant_id, {
        search: req.query.search,
        status: req.query.status,
        aging_bucket: req.query.aging_bucket,
      });
      return res.json({ success: true, data });
    }
    const data = await VendorBill.find({ tenant_id: req.tenant_id }).sort({ issue_date: -1 });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/vendor-bills', authorize('business_owner', 'accountant'), async (req, res) => {
  const { vendor_name, supplier_id, issue_date, due_date, lines, notes, expense_account_id } = req.body;
  if (!vendor_name || !due_date || !lines?.length) {
    return res.status(400).json({ success: false, message: 'vendor_name, due_date and lines required.' });
  }
  let subtotal = 0; let tax_amount = 0;
  const enriched = lines.map((l) => {
    const lineTotal = parseFloat(l.quantity || 1) * parseFloat(l.unit_price || 0);
    const lineTax = lineTotal * (parseFloat(l.tax_rate || 0) / 100);
    subtotal += lineTotal;
    tax_amount += lineTax;
    return { ...l, total: lineTotal + lineTax };
  });
  const total = subtotal + tax_amount;
  const count = await VendorBill.countDocuments({ tenant_id: req.tenant_id });
  const bill = await VendorBill.create({
    tenant_id: req.tenant_id,
    bill_number: billNumber(count + 1),
    vendor_name,
    supplier_id: supplier_id || null,
    issue_date: issue_date || new Date(),
    due_date: new Date(due_date),
    lines: enriched,
    subtotal, tax_amount, total,
    amount_paid: 0, amount_due: total,
    expense_account_id: expense_account_id || null,
    status: 'draft',
    notes,
    created_by: req.user._id,
  });
  res.status(201).json({ success: true, data: bill });
});

router.patch('/vendor-bills/:id/post', authorize('business_owner', 'accountant'), async (req, res) => {
  const bill = await VendorBill.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!bill) return res.status(404).json({ success: false, message: 'Vendor bill not found.' });
  if (bill.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft bills can be posted.' });
  let expenseCode = '5900';
  if (bill.expense_account_id) {
    const acc = await Account.findOne({ _id: bill.expense_account_id, tenant_id: req.tenant_id });
    if (acc) expenseCode = acc.code;
  }
  const entry = await accounting.postVendorBillEntry({
    tenantId: req.tenant_id,
    amount: bill.total,
    taxAmount: bill.tax_amount,
    expenseAccountCode: expenseCode,
    reference: bill.bill_number,
    date: bill.issue_date,
    sourceId: bill._id,
    createdBy: req.user._id,
  });
  bill.status = 'posted';
  bill.journal_entry_id = entry._id;
  await bill.save();
  res.json({ success: true, data: bill });
});

router.post('/vendor-bills/:id/payments', authorize('business_owner', 'accountant'), async (req, res) => {
  const { amount, method, reference, note, date } = req.body;
  const bill = await VendorBill.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!bill) return res.status(404).json({ success: false, message: 'Vendor bill not found.' });
  if (['draft', 'void', 'paid'].includes(bill.status)) {
    return res.status(400).json({ success: false, message: `Cannot pay bill in status ${bill.status}.` });
  }
  const paying = Math.min(parseFloat(amount), bill.amount_due);
  if (!paying || paying <= 0) return res.status(400).json({ success: false, message: 'amount required.' });
  bill.payments.push({ amount: paying, method: method || 'bank_transfer', reference, note, date: date ? new Date(date) : new Date() });
  bill.amount_paid += paying;
  bill.amount_due = bill.total - bill.amount_paid;
  bill.status = bill.amount_due <= 0.01 ? 'paid' : 'partially_paid';
  await bill.save();
  await accounting.postPurchasePaymentEntry({
    tenantId: req.tenant_id,
    amount: paying,
    reference: `${bill.bill_number}-${Date.now()}`,
    date: new Date(),
    sourceId: bill._id,
    createdBy: req.user._id,
  });
  res.json({ success: true, data: bill });
});

router.patch('/vendor-bills/:id/void', authorize('business_owner', 'accountant'), async (req, res) => {
  const bill = await VendorBill.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!bill) return res.status(404).json({ success: false, message: 'Vendor bill not found.' });
  if (bill.amount_paid > 0) return res.status(400).json({ success: false, message: 'Cannot void a bill with payments recorded.' });
  if (bill.journal_entry_id) {
    await accounting.voidJournalEntry(bill.journal_entry_id, req.tenant_id, req.user._id, `Vendor bill ${bill.bill_number} voided`);
  }
  bill.status = 'void';
  await bill.save();
  res.json({ success: true, data: bill });
});

// BANK RECONCILIATION — persistent sessions
router.get('/accounting/reconciliations', async (req, res) => {
  try {
    if (req.query.view === 'full') {
      const data = await accounting.buildReconciliationView(req.tenant_id);
      return res.json({ success: true, data });
    }
    const data = await BankReconciliation.find({ tenant_id: req.tenant_id }).sort({ statement_date: -1 }).limit(50);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/accounting/reconciliations/:id', async (req, res) => {
  try {
    const data = await accounting.buildReconciliationSessionDetail(req.tenant_id, req.params.id);
    if (!data) return res.status(404).json({ success: false, message: 'Reconciliation session not found.' });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/accounting/reconciliations', authorize('business_owner', 'accountant'), async (req, res) => {
  const { account_id, statement_date, opening_balance, closing_balance, bank_lines, matched_pairs, notes, period_from, period_to, summary } = req.body;
  let account;
  if (account_id) {
    account = await Account.findOne({ _id: account_id, tenant_id: req.tenant_id });
  } else {
    account = await Account.findOne({ tenant_id: req.tenant_id, code: '1001' });
  }
  if (!account) return res.status(404).json({ success: false, message: 'Bank account not found.' });
  const data = await BankReconciliation.create({
    tenant_id: req.tenant_id,
    account_id: account._id,
    statement_date: statement_date ? new Date(statement_date) : new Date(),
    opening_balance: parseFloat(opening_balance) || 0,
    closing_balance: parseFloat(closing_balance) || 0,
    bank_lines: bank_lines || [],
    matched_pairs: matched_pairs || [],
    status: 'draft',
    notes: notes || (summary ? JSON.stringify({ period_from, period_to, summary }) : undefined),
  });
  res.status(201).json({ success: true, data });
});

router.patch('/accounting/reconciliations/:id/complete', authorize('business_owner', 'accountant'), async (req, res) => {
  const recon = await BankReconciliation.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!recon) return res.status(404).json({ success: false, message: 'Reconciliation not found.' });
  recon.status = 'completed';
  recon.completed_by = req.user._id;
  recon.completed_at = new Date();
  if (req.body.matched_pairs) recon.matched_pairs = req.body.matched_pairs;
  if (req.body.bank_lines) recon.bank_lines = req.body.bank_lines;
  await recon.save();
  res.json({ success: true, data: recon });
});

// DEPRECIATION RUN
router.post('/accounting/depreciation/run', authorize('business_owner', 'accountant'), async (req, res) => {
  const { month, year, rate = 0.1 } = req.body;
  const { Asset: AssetModel } = require('../models');
  const assets = await AssetModel.find({ tenant_id: req.tenant_id, status: 'active', purchase_value: { $gt: 0 } });
  const periodLabel = month && year ? `${month}/${year}` : new Date().toISOString().slice(0, 7);
  const results = [];
  for (const asset of assets) {
    const monthly = accounting.round2((asset.current_value || asset.purchase_value) * (parseFloat(rate) / 12));
    if (monthly <= 0) continue;
    const entry = await accounting.postDepreciationEntry({
      tenantId: req.tenant_id,
      amount: monthly,
      reference: `${asset.asset_code}-${periodLabel}`,
      date: new Date(),
      sourceId: asset._id,
      createdBy: req.user._id,
    });
    asset.current_value = Math.max(0, accounting.round2((asset.current_value || asset.purchase_value) - monthly));
    await asset.save();
    results.push({ asset_code: asset.asset_code, amount: monthly, journal_id: entry._id });
  }
  res.json({ success: true, data: { posted: results.length, entries: results } });
});

// Ensure advanced COA accounts exist for existing tenants
router.post('/accounting/seed-coa', authorize('business_owner', 'accountant'), async (req, res) => {
  await accounting.seedChartOfAccounts(req.tenant_id);
  res.json({ success: true, message: 'Chart of accounts updated.' });
});


module.exports = router;
