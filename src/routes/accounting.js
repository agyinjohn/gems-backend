const express = require('express');
const router = express.Router();
const { authenticate, authorize, requireTenant } = require('../middleware/auth');
const accounting = require('../services/accountingService');
const {
  Account, Expense, JournalEntry, TaxRate, Budget,
  Order, PurchaseOrder, PayrollRun,
  Invoice, CreditNote, AccountingPeriod,
} = require('../models');

// ACCOUNTING
// Trial Balance — GL-derived source of truth
router.get('/accounting/trial-balance', authenticate, requireTenant, async (req, res) => {
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

router.get('/accounts', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const [accounts, jeBalances] = await Promise.all([
    Account.find({ tenant_id: tid, is_active: true }).sort('code'),
    JournalEntry.aggregate([
      { $match: { tenant_id: tid, status: { $ne: 'voided' } } },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.account_id', balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
  ]);
  const jeMap = Object.fromEntries(jeBalances.map(b => [String(b._id), b.balance]));
  const data = accounts.map(a => ({ ...a.toJSON(), balance: jeMap[String(a._id)] || 0 }));
  res.json({ success: true, data });
});
router.post('/accounts', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const { code, name, type, description } = req.body;
  if (!code || !name || !type) return res.status(400).json({ success: false, message: 'code, name and type required.' });
  const exists = await Account.findOne({ tenant_id: req.tenant_id, code });
  if (exists) return res.status(400).json({ success: false, message: 'Account code already exists.' });
  const data = await Account.create({ tenant_id: req.tenant_id, code, name, type, description });
  res.status(201).json({ success: true, data });
});
router.put('/accounts/:id', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const { name, type, description } = req.body;
  // Note: balance is NOT stored on the Account document — it is computed live
  // from journal entry lines. To change a balance, post a journal entry instead.
  const data = await Account.findOneAndUpdate(
    { _id: req.params.id, tenant_id: req.tenant_id },
    { name, type, description },
    { new: true }
  );
  if (!data) return res.status(404).json({ success: false, message: 'Account not found.' });
  res.json({ success: true, data });
});
router.get('/expenses', authenticate, requireTenant, async (req, res) => {
  const data = await Expense.find({ tenant_id: req.tenant_id }).populate('created_by', 'name').sort({ expense_date: -1 });
  res.json({ success: true, data });
});
router.post('/expenses', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const { title, category, amount, account_id, description, expense_date, receipt } = req.body;
  if (!title || !amount) return res.status(400).json({ success: false, message: 'title and amount required.' });
  const data = await Expense.create({ tenant_id: req.tenant_id, title, category, amount, account_id: account_id || null, description, expense_date: expense_date || Date.now(), receipt: receipt || null, created_by: req.user._id });
  res.status(201).json({ success: true, data });
});
router.put('/expenses/:id', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const { title, category, amount, account_id, description, expense_date, receipt } = req.body;
  const update = { title, category, amount, account_id: account_id || null, description, expense_date };
  if (receipt !== undefined) update.receipt = receipt || null;
  const data = await Expense.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, update, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Expense not found.' });
  res.json({ success: true, data });
});
router.delete('/expenses/:id', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  await Expense.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant_id });
  res.json({ success: true, message: 'Deleted.' });
});
router.get('/journal-entries', authenticate, requireTenant, async (req, res) => {
  const data = await JournalEntry.find({ tenant_id: req.tenant_id }).sort({ entry_date: -1 }).limit(100);
  res.json({ success: true, data });
});
router.post('/journal-entries', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const { description, entry_date, lines } = req.body;
  if (!description || !lines?.length) return res.status(400).json({ success: false, message: 'description and lines required.' });
  const total_debit  = lines.reduce((s, l) => s + (parseFloat(l.debit)  || 0), 0);
  const total_credit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  if (Math.abs(total_debit - total_credit) > 0.01) {
    return res.status(400).json({ success: false, message: `Journal entry is unbalanced: debits ${total_debit.toFixed(2)} ≠ credits ${total_credit.toFixed(2)}` });
  }
  const data = await JournalEntry.create({ tenant_id: req.tenant_id, reference: `JE-${Date.now()}`, description, total_debit, total_credit, entry_date: entry_date || Date.now(), lines, created_by: req.user._id, status: 'posted' });
  res.status(201).json({ success: true, data });
});

router.post('/journal-entries/:id/void', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const reversal = await accounting.voidJournalEntry(req.params.id, req.tenant_id, req.user._id, req.body.reason);
  res.json({ success: true, data: reversal });
});
router.get('/accounting/cashflow', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const match = { tenant_id: tid };
  const expMatch = { tenant_id: tid };
  const poMatch = { tenant_id: tid, payment_status: 'paid' };
  const payrollMatch = { tenant_id: tid, status: 'approved' };
  if (req.query.from || req.query.to) {
    match.createdAt = {}; expMatch.expense_date = {}; poMatch.paid_at = {}; payrollMatch.createdAt = {};
    if (req.query.from) {
      const f = new Date(req.query.from);
      match.createdAt.$gte = f; expMatch.expense_date.$gte = f; poMatch.paid_at.$gte = f; payrollMatch.createdAt.$gte = f;
    }
    if (req.query.to) {
      const t = new Date(req.query.to);
      match.createdAt.$lte = t; expMatch.expense_date.$lte = t; poMatch.paid_at.$lte = t; payrollMatch.createdAt.$lte = t;
    }
  }
  const [salesAgg, expAgg, poAgg, payrollAgg, cashAccount, jeBalances] = await Promise.all([
    Order.aggregate([{ $match: { ...match, payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Expense.aggregate([{ $match: expMatch }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    PurchaseOrder.aggregate([{ $match: poMatch }, { $group: { _id: null, total: { $sum: '$total_cost' } } }]),
    PayrollRun.aggregate([{ $match: payrollMatch }, { $group: { _id: null, total: { $sum: '$net_salary' } } }]),
    Account.findOne({ tenant_id: tid, code: '1001' }),
    JournalEntry.aggregate([
      { $match: { tenant_id: tid } },
      { $unwind: '$lines' },
      { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
      { $unwind: '$acc' },
      { $match: { 'acc.code': '1001' } },
      { $group: { _id: null, balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
  ]);
  const cashFromSales     =  salesAgg[0]?.total   || 0;
  const cashPaidExpenses  = -(expAgg[0]?.total     || 0);
  const cashPaidSuppliers = -(poAgg[0]?.total      || 0);
  const cashPaidPayroll   = -(payrollAgg[0]?.total || 0);
  const operatingNet = cashFromSales + cashPaidExpenses + cashPaidSuppliers + cashPaidPayroll;
  const openingBalance = 0; // simplified — would need prior period balance in a full system
  const closingBalance = jeBalances[0]?.balance || operatingNet;
  res.json({ success: true, data: {
    operating: {
      cash_from_sales:     cashFromSales,
      cash_paid_expenses:  cashPaidExpenses,
      cash_paid_suppliers: cashPaidSuppliers,
      cash_paid_payroll:   cashPaidPayroll,
      net: operatingNet,
    },
    investing:  { items: [], net: 0 },
    financing:  { items: [], net: 0 },
    opening_balance: openingBalance,
    net_change:      operatingNet,
    closing_balance: closingBalance,
  }});
});

router.get('/accounting/balance-sheet', authenticate, requireTenant, async (req, res) => {
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
  const ppe                = gl('1210');
  const accumDepr          = gl('1220'); // normally negative (credit balance)
  const totalCurrentAssets    = cash + accountsReceivable + inventory + prepaid;
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

router.get('/accounting/vat-return', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const match = { tenant_id: tid, status: { $ne: 'voided' } };
  if (req.query.from || req.query.to) {
    match.entry_date = {};
    if (req.query.from) match.entry_date.$gte = new Date(req.query.from);
    if (req.query.to)   match.entry_date.$lte = new Date(req.query.to);
  }
  // Output VAT = credits on VAT Payable (2110) — collected from customers
  // Input VAT  = debits on VAT Input account (if exists) — paid to suppliers
  const vatAccount = await Account.findOne({ tenant_id: tid, code: '2110' });
  if (!vatAccount) return res.status(404).json({ success: false, message: 'VAT Payable account (2110) not found.' });

  const vatLines = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.account_id': vatAccount._id } },
    { $group: { _id: null, output_vat: { $sum: '$lines.credit' }, input_vat: { $sum: '$lines.debit' } } },
  ]);

  const output_vat = vatLines[0]?.output_vat || 0;
  const input_vat  = vatLines[0]?.input_vat  || 0;
  const net_vat_payable = output_vat - input_vat;

  res.json({ success: true, data: {
    period: { from: req.query.from || null, to: req.query.to || null },
    output_vat,
    input_vat,
    net_vat_payable,
    status: net_vat_payable >= 0 ? 'payable' : 'reclaimable',
  }});
});

router.get('/accounting/pl', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const match = { tenant_id: tid, payment_status: 'paid' };
  const expMatch = { tenant_id: tid };
  if (req.query.from || req.query.to) {
    match.createdAt = {}; expMatch.expense_date = {};
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
  res.json({ success: true, data: {
    revenue, gross_profit: revenue - (cogs[0]?.cogs || 0), total_expenses: totalExpenses, net_profit: revenue - totalExpenses,
    expenses_by_category: expByCategory.map(e => ({ category: e._id, total: e.total })), monthly,
  }});
});

router.get('/accounting/summary', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const [rev, exp, monthlyRev, expByCategory, cogsAgg] = await Promise.all([
    Order.aggregate([{ $match: { tenant_id: tid, payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Expense.aggregate([{ $match: { tenant_id: tid } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Order.aggregate([
      { $match: { tenant_id: tid, payment_status: 'paid', createdAt: { $gte: yearStart } } },
      { $group: { _id: { month: { $month: '$createdAt' } }, revenue: { $sum: '$total' } } },
      { $sort: { '_id.month': 1 } },
      { $project: { month: { $arrayElemAt: [['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], '$_id.month'] }, revenue: 1 } },
    ]),
    Expense.aggregate([{ $match: { tenant_id: tid } }, { $group: { _id: { $ifNull: ['$category','Uncategorized'] }, total: { $sum: '$amount' } } }, { $sort: { total: -1 } }]),
    Order.aggregate([{ $match: { tenant_id: tid, payment_status: 'paid' } }, { $group: { _id: null, cogs: { $sum: '$subtotal' } } }]),
  ]);
  const totalRevenue = rev[0]?.total || 0;
  const totalExpenses = exp[0]?.total || 0;
  const cogs = cogsAgg[0]?.cogs || 0;
  res.json({ success: true, data: {
    revenue: totalRevenue, expenses: totalExpenses, cogs,
    gross_profit: totalRevenue - cogs, net_profit: totalRevenue - totalExpenses,
    monthly_revenue: monthlyRev,
    expenses_by_category: expByCategory.map(e => ({ category: e._id, total: e.total })),
  }});
});

router.get('/accounting/gl/:accountId', authenticate, requireTenant, async (req, res) => {
  const account = await Account.findOne({ _id: req.params.accountId, tenant_id: req.tenant_id });
  if (!account) return res.status(404).json({ success: false, message: 'Account not found.' });
  const entries = await JournalEntry.find({ tenant_id: req.tenant_id, 'lines.account_id': account._id }).sort({ entry_date: -1 }).limit(100);
  const lines = [];
  let running = 0;
  for (const entry of [...entries].reverse()) {
    for (const line of entry.lines) {
      if (String(line.account_id) === String(account._id)) {
        running += (line.debit || 0) - (line.credit || 0);
        lines.push({ date: entry.entry_date, reference: entry.reference, description: line.description || entry.description, debit: line.debit, credit: line.credit, balance: running });
      }
    }
  }
  res.json({ success: true, data: { account, lines: lines.reverse() } });
});

router.post('/accounting/reconcile', authenticate, requireTenant, async (req, res) => {
  const { lines } = req.body;
  if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ success: false, message: 'lines array required.' });
  const cashAccount = await Account.findOne({ tenant_id: req.tenant_id, code: '1001' });
  if (!cashAccount) return res.status(404).json({ success: false, message: 'Cash & Bank account (1001) not found.' });
  const glEntries = await JournalEntry.find({ tenant_id: req.tenant_id, 'lines.account_id': cashAccount._id }).sort({ entry_date: 1 });
  const glLines = [];
  for (const entry of glEntries) {
    for (const line of entry.lines) {
      if (String(line.account_id) === String(cashAccount._id)) {
        glLines.push({ id: String(line._id), date: entry.entry_date, description: line.description || entry.description, reference: entry.reference, amount: (line.debit || 0) - (line.credit || 0) });
      }
    }
  }
  const matched = [], unmatchedBank = [], usedGlIds = new Set();
  for (const bankLine of lines) {
    const bankAmt = parseFloat(bankLine.amount);
    const match = glLines.find(g => !usedGlIds.has(g.id) && Math.abs(g.amount - bankAmt) < 0.01);
    if (match) { usedGlIds.add(match.id); matched.push({ bank: bankLine, gl: match }); }
    else unmatchedBank.push(bankLine);
  }
  const unmatchedGl = glLines.filter(g => !usedGlIds.has(g.id));
  const bankTotal = lines.reduce((s, l) => s + parseFloat(l.amount), 0);
  const glTotal   = glLines.reduce((s, l) => s + l.amount, 0);
  res.json({ success: true, data: { matched, unmatchedBank, unmatchedGl, bankTotal, glTotal, difference: bankTotal - glTotal, isBalanced: Math.abs(bankTotal - glTotal) < 0.01 } });
});

// AP LEDGER — GL-derived accounts payable
router.get('/accounting/ap-ledger', authenticate, requireTenant, async (req, res) => {
  const tid = req.tenant_id;

  const apAccount = await Account.findOne({ tenant_id: tid, code: '2001' });
  if (!apAccount) return res.json({ success: true, data: { entries: [], total_outstanding: 0 } });

  // Get every JE line touching 2001, grouped by journal entry
  const lines = await JournalEntry.aggregate([
    { $match: { tenant_id: tid, status: { $ne: 'voided' } } },
    { $unwind: '$lines' },
    { $match: { 'lines.account_id': apAccount._id } },
    { $group: {
      _id: '$_id',
      reference:   { $first: '$reference' },
      description: { $first: '$description' },
      entry_date:  { $first: '$entry_date' },
      source:      { $first: '$source' },
      source_id:   { $first: '$source_id' },
      debit:  { $sum: '$lines.debit' },
      credit: { $sum: '$lines.credit' },
    }},
    { $sort: { entry_date: -1 } },
  ]);

  // Running balance per source_id — net credit = still owed, net debit = already paid
  // Group by source_id so PO creation + PO payment cancel each other out
  const sourceMap = {};
  for (const l of lines) {
    const key = l.source_id ? String(l.source_id) : String(l._id);
    if (!sourceMap[key]) sourceMap[key] = { reference: l.reference, description: l.description, entry_date: l.entry_date, source: l.source, debit: 0, credit: 0 };
    sourceMap[key].debit  += l.debit;
    sourceMap[key].credit += l.credit;
  }

  // Only show entries where credit > debit (still owed)
  const entries = Object.values(sourceMap)
    .map((e) => ({ ...e, outstanding: parseFloat((e.credit - e.debit).toFixed(2)) }))
    .filter((e) => e.outstanding > 0.01)
    .sort((a, b) => new Date(b.entry_date) - new Date(a.entry_date));

  // Also pull matching PO details for context
  const poRefs = entries.map(e => e.reference).filter(r => r.startsWith('PO-RCV-'));
  const poNumbers = poRefs.map(r => r.replace('PO-RCV-', ''));
  const pos = poNumbers.length
    ? await (require('../models').PurchaseOrder).find({ tenant_id: tid, po_number: { $in: poNumbers } }).populate('supplier_id', 'name')
    : [];
  const poMap = Object.fromEntries(pos.map(p => [p.po_number, p]));

  const enriched = entries.map(e => {
    const poNum = e.reference.replace('PO-RCV-', '');
    const po = poMap[poNum];
    return {
      reference:   e.reference,
      description: e.description,
      entry_date:  e.entry_date,
      source:      e.source,
      outstanding: e.outstanding,
      supplier:    po?.supplier_id?.name || null,
      po_number:   po?.po_number || null,
      po_status:   po?.po_status || po?.status || null,
      po_id:       po?._id || null,
      payments:    po?.payments || [],
    };
  });

  const total_outstanding = parseFloat(enriched.reduce((s, e) => s + e.outstanding, 0).toFixed(2));
  res.json({ success: true, data: { entries: enriched, total_outstanding } });
});

// BUDGETS
router.get('/budgets', authenticate, requireTenant, async (req, res) => {
  const { period, period_type } = req.query;
  const filter = { tenant_id: req.tenant_id };
  if (period) filter.period = period;
  if (period_type) filter.period_type = period_type;
  const data = await Budget.find(filter).sort('category');
  res.json({ success: true, data });
});
router.post('/budgets', authenticate, requireTenant, authorize('business_owner','accountant'), async (req, res) => {
  const { category, period, period_type, amount } = req.body;
  if (!category || !period || !amount) return res.status(400).json({ success: false, message: 'category, period and amount required.' });
  const data = await Budget.findOneAndUpdate(
    { tenant_id: req.tenant_id, category, period },
    { amount, period_type: period_type || 'monthly' },
    { upsert: true, new: true }
  );
  res.status(201).json({ success: true, data });
});
router.put('/budgets/:id', authenticate, requireTenant, authorize('business_owner','accountant'), async (req, res) => {
  const { amount } = req.body;
  const data = await Budget.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { amount }, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Budget not found.' });
  res.json({ success: true, data });
});
router.delete('/budgets/:id', authenticate, requireTenant, authorize('business_owner','accountant'), async (req, res) => {
  await Budget.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant_id });
  res.json({ success: true, message: 'Deleted.' });
});
router.get('/budgets/vs-actual', authenticate, requireTenant, async (req, res) => {
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
router.get('/tax-rates', authenticate, requireTenant, async (req, res) => {
  const data = await TaxRate.find({ tenant_id: req.tenant_id }).sort('name');
  res.json({ success: true, data });
});
router.post('/tax-rates', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const { name, rate, applies_to } = req.body;
  if (!name || rate === undefined) return res.status(400).json({ success: false, message: 'name and rate required.' });
  const data = await TaxRate.create({ tenant_id: req.tenant_id, name, rate, applies_to: applies_to || 'both' });
  res.status(201).json({ success: true, data });
});
router.put('/tax-rates/:id', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const { name, rate, applies_to, is_active } = req.body;
  const data = await TaxRate.findOneAndUpdate({ _id: req.params.id, tenant_id: req.tenant_id }, { name, rate, applies_to, is_active }, { new: true });
  if (!data) return res.status(404).json({ success: false, message: 'Tax rate not found.' });
  res.json({ success: true, data });
});
router.delete('/tax-rates/:id', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  await TaxRate.findOneAndDelete({ _id: req.params.id, tenant_id: req.tenant_id });
  res.json({ success: true, message: 'Deleted.' });
});

// INVOICES
const invoiceNumber = (n) => `INV-${String(n).padStart(5, '0')}`;
const creditNoteNumber = (n) => `CN-${String(n).padStart(5, '0')}`;

router.get('/invoices', authenticate, requireTenant, async (req, res) => {
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

router.get('/invoices/:id', authenticate, requireTenant, async (req, res) => {
  const data = await Invoice.findOne({ _id: req.params.id, tenant_id: req.tenant_id }).populate('customer_id', 'name email phone');
  if (!data) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  res.json({ success: true, data });
});

router.post('/invoices', authenticate, requireTenant, authorize('business_owner', 'accountant', 'sales_staff'), async (req, res) => {
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

router.patch('/invoices/:id/send', authenticate, requireTenant, authorize('business_owner', 'accountant', 'sales_staff'), async (req, res) => {
  const inv = await Invoice.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  if (inv.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft invoices can be sent.' });
  inv.status = 'sent';
  await inv.save();
  // Post GL: Dr Accounts Receivable / Cr Sales Revenue
  await accounting.postSaleEntry({
    tenantId: req.tenant_id, amount: inv.total, cogsAmount: 0,
    taxAmount: inv.tax_amount, reference: inv.invoice_number,
    date: inv.issue_date, sourceId: inv._id, createdBy: req.user._id, isCredit: true,
  }).catch(() => {});
  res.json({ success: true, data: inv });
});

router.post('/invoices/:id/payments', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
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

router.patch('/invoices/:id/void', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
  const inv = await Invoice.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found.' });
  if (inv.status === 'paid') return res.status(400).json({ success: false, message: 'Cannot void a paid invoice. Issue a credit note instead.' });
  inv.status = 'void';
  await inv.save();
  res.json({ success: true, data: inv });
});

// CREDIT NOTES
router.get('/credit-notes', authenticate, requireTenant, async (req, res) => {
  const data = await CreditNote.find({ tenant_id: req.tenant_id }).populate('invoice_id', 'invoice_number').sort({ createdAt: -1 });
  res.json({ success: true, data });
});

router.post('/credit-notes', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
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

  // Post GL reversal: Dr Sales Revenue / Cr Cash & Bank (refund)
  await accounting.postJournalEntry({
    tenantId: req.tenant_id,
    description: `Credit note ${cn.credit_note_number} — ${reason}`,
    date: new Date(),
    lines: [
      { accountCode: '4001', debit: creditAmt, credit: 0,          description: `Credit note ${cn.credit_note_number}` },
      { accountCode: '1001', debit: 0,         credit: creditAmt,  description: `Refund ${cn.credit_note_number}` },
    ],
    source: 'manual', sourceId: cn._id, createdBy: req.user._id,
    reference: `CN-${cn.credit_note_number}`,
  }).catch(() => {});

  res.status(201).json({ success: true, data: cn });
});

// ACCOUNTING PERIODS
router.get('/accounting/periods', authenticate, requireTenant, async (req, res) => {
  const data = await AccountingPeriod.find({ tenant_id: req.tenant_id }).sort({ start_date: -1 });
  res.json({ success: true, data });
});

router.post('/accounting/periods', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
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

router.patch('/accounting/periods/:id/close', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
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

router.patch('/accounting/periods/:id/reopen', authenticate, requireTenant, authorize('business_owner'), async (req, res) => {
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
router.post('/accounting/periods/:id/year-end-close', authenticate, requireTenant, authorize('business_owner', 'accountant'), async (req, res) => {
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

// Block posting to closed periods — middleware check used by journal entry POST
router.use('/journal-entries', async (req, res, next) => {
  if (req.method !== 'POST' || !req.tenant_id) return next();
  const entryDate = req.body?.entry_date ? new Date(req.body.entry_date) : new Date();
  const closedPeriod = await AccountingPeriod.findOne({
    tenant_id: req.tenant_id,
    status: 'closed',
    start_date: { $lte: entryDate },
    end_date:   { $gte: entryDate },
  });
  if (closedPeriod) return res.status(400).json({ success: false, message: `Cannot post to closed period: ${closedPeriod.name}` });
  next();
});


module.exports = router;
