const { JournalEntry, Account, AccountingPeriod, Invoice, Expense, Order, PurchaseOrder, VendorBill, CreditNote, BankReconciliation, Budget, TaxRate } = require('../models');

const MONTH_LABELS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STANDARD_COA = [
  { code: '1000', name: 'Assets',               type: 'asset',     level: 1, is_group: true,  parent_code: null },
  { code: '1100', name: 'Current Assets',        type: 'asset',     level: 2, is_group: true,  parent_code: '1000' },
  { code: '1001', name: 'Cash & Bank',           type: 'asset',     level: 3, is_group: false, parent_code: '1100' },
  { code: '1110', name: 'Accounts Receivable',   type: 'asset',     level: 3, is_group: false, parent_code: '1100' },
  { code: '1120', name: 'Inventory',             type: 'asset',     level: 3, is_group: false, parent_code: '1100' },
  { code: '1130', name: 'Prepaid Expenses',      type: 'asset',     level: 3, is_group: false, parent_code: '1100' },
  { code: '1135', name: 'VAT Input',             type: 'asset',     level: 3, is_group: false, parent_code: '1100' },
  { code: '1200', name: 'Non-Current Assets',    type: 'asset',     level: 2, is_group: true,  parent_code: '1000' },
  { code: '1210', name: 'Property & Equipment',  type: 'asset',     level: 3, is_group: false, parent_code: '1200' },
  { code: '1220', name: 'Accumulated Depreciation', type: 'asset',  level: 3, is_group: false, parent_code: '1200' },
  { code: '2000', name: 'Liabilities',           type: 'liability', level: 1, is_group: true,  parent_code: null },
  { code: '2100', name: 'Current Liabilities',   type: 'liability', level: 2, is_group: true,  parent_code: '2000' },
  { code: '2001', name: 'Accounts Payable',      type: 'liability', level: 3, is_group: false, parent_code: '2100' },
  { code: '2110', name: 'VAT Payable',           type: 'liability', level: 3, is_group: false, parent_code: '2100' },
  { code: '2120', name: 'Accrued Liabilities',   type: 'liability', level: 3, is_group: false, parent_code: '2100' },
  { code: '2130', name: 'Salaries Payable',      type: 'liability', level: 3, is_group: false, parent_code: '2100' },
  { code: '2140', name: 'SSNIT Payable',         type: 'liability', level: 3, is_group: false, parent_code: '2100' },
  { code: '2141', name: 'PAYE Payable',          type: 'liability', level: 3, is_group: false, parent_code: '2100' },
  { code: '2200', name: 'Non-Current Liabilities', type: 'liability', level: 2, is_group: true, parent_code: '2000' },
  { code: '2210', name: 'Long-Term Loans',       type: 'liability', level: 3, is_group: false, parent_code: '2200' },
  { code: '3000', name: 'Equity',                type: 'equity',    level: 1, is_group: true,  parent_code: null },
  { code: '3001', name: "Owner's Equity",        type: 'equity',    level: 3, is_group: false, parent_code: '3000' },
  { code: '3900', name: 'Retained Earnings',     type: 'equity',    level: 3, is_group: false, parent_code: '3000' },
  { code: '4000', name: 'Revenue',               type: 'revenue',   level: 1, is_group: true,  parent_code: null },
  { code: '4001', name: 'Sales Revenue',         type: 'revenue',   level: 3, is_group: false, parent_code: '4000' },
  { code: '4010', name: 'Service Revenue',       type: 'revenue',   level: 3, is_group: false, parent_code: '4000' },
  { code: '4900', name: 'Other Income',          type: 'revenue',   level: 3, is_group: false, parent_code: '4000' },
  { code: '5000', name: 'Expenses',              type: 'expense',   level: 1, is_group: true,  parent_code: null },
  { code: '5001', name: 'Cost of Goods Sold',    type: 'expense',   level: 3, is_group: false, parent_code: '5000' },
  { code: '5100', name: 'Salaries & Wages',      type: 'expense',   level: 3, is_group: false, parent_code: '5000' },
  { code: '5200', name: 'Office Expenses',       type: 'expense',   level: 3, is_group: false, parent_code: '5000' },
  { code: '5300', name: 'Rent & Utilities',      type: 'expense',   level: 3, is_group: false, parent_code: '5000' },
  { code: '5400', name: 'Marketing & Advertising', type: 'expense', level: 3, is_group: false, parent_code: '5000' },
  { code: '5500', name: 'Depreciation',          type: 'expense',   level: 3, is_group: false, parent_code: '5000' },
  { code: '5600', name: 'Bank Charges',          type: 'expense',   level: 3, is_group: false, parent_code: '5000' },
  { code: '5900', name: 'Other Expenses',        type: 'expense',   level: 3, is_group: false, parent_code: '5000' },
];

function round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

const STANDARD_CODE_SET = new Set(STANDARD_COA.map((a) => a.code));

function isDebitNormalType(type) {
  return type === 'asset' || type === 'expense';
}

function displayBalanceFromNet(type, rawNet) {
  return isDebitNormalType(type) ? round2(rawNet) : round2(-rawNet);
}

async function postOpeningBalanceEntry(tenantId, account, displayBalance, createdBy) {
  const amount = Math.abs(round2(displayBalance));
  if (amount <= 0) return null;

  const equity = await Account.findOne({ tenant_id: tenantId, code: '3001', is_active: true });
  if (!equity) throw new Error("Owner's Equity account (3001) not found. Run Update COA first.");

  const isDebitNormal = isDebitNormalType(account.type);
  const targetDebit = isDebitNormal ? (displayBalance > 0 ? amount : 0) : (displayBalance < 0 ? amount : 0);
  const targetCredit = isDebitNormal ? (displayBalance < 0 ? amount : 0) : (displayBalance > 0 ? amount : 0);

  return postJournalEntry({
    tenantId,
    description: `Opening balance — ${account.name}`,
    date: new Date(),
    lines: [
      { accountCode: account.code, debit: targetDebit, credit: targetCredit, description: `Opening balance ${account.code}` },
      { accountCode: '3001', debit: targetCredit, credit: targetDebit, description: `Opening balance offset — ${account.code}` },
    ],
    source: 'manual',
    sourceId: account._id,
    createdBy,
    reference: `OB-${account.code}-${Date.now()}`,
  });
}

async function postBalanceAdjustmentEntry(tenantId, account, diff, createdBy) {
  const amount = Math.abs(round2(diff));
  if (amount <= 0.001) return null;

  const equity = await Account.findOne({ tenant_id: tenantId, code: '3001', is_active: true });
  if (!equity) throw new Error("Owner's Equity account (3001) not found.");

  const isDebitNormal = isDebitNormalType(account.type);
  const targetDebit = isDebitNormal ? (diff > 0 ? amount : 0) : (diff < 0 ? amount : 0);
  const targetCredit = isDebitNormal ? (diff < 0 ? amount : 0) : (diff > 0 ? amount : 0);

  return postJournalEntry({
    tenantId,
    description: `Balance adjustment — ${account.name}`,
    date: new Date(),
    lines: [
      { accountCode: account.code, debit: targetDebit, credit: targetCredit, description: `Adjust ${account.name}` },
      { accountCode: '3001', debit: targetCredit, credit: targetDebit, description: `Offset — ${account.name} adjustment` },
    ],
    source: 'manual',
    sourceId: account._id,
    createdBy,
    reference: `ADJ-${account.code}-${Date.now()}`,
  });
}

async function buildAccountsCoaView(tenantId, options = {}) {
  const includeGroups = options.include_groups !== false;
  const activeOnly = options.active_only !== false;
  const typeFilter = options.type || null;
  const search = String(options.search || '').trim().toLowerCase();

  const filter = { tenant_id: tenantId };
  if (activeOnly) filter.is_active = true;
  if (typeFilter) filter.type = typeFilter;

  const [accounts, jeStats] = await Promise.all([
    Account.find(filter).sort('code'),
    JournalEntry.aggregate([
      { $match: { tenant_id: tenantId, status: { $ne: 'voided' } } },
      { $unwind: '$lines' },
      { $group: {
        _id: '$lines.account_id',
        balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
        debit_total: { $sum: '$lines.debit' },
        credit_total: { $sum: '$lines.credit' },
        entry_ids: { $addToSet: '$_id' },
        last_activity: { $max: '$entry_date' },
      }},
      { $project: {
        balance: 1,
        debit_total: 1,
        credit_total: 1,
        last_activity: 1,
        entry_count: { $size: '$entry_ids' },
      }},
    ]),
  ]);

  const statsMap = Object.fromEntries(jeStats.map((s) => [String(s._id), s]));
  const byId = Object.fromEntries(accounts.map((a) => [String(a._id), a]));

  const rows = accounts
    .filter((a) => includeGroups || !a.is_group)
    .map((a) => {
      const json = a.toJSON();
      const stats = statsMap[String(a._id)] || {
        balance: 0, debit_total: 0, credit_total: 0, entry_count: 0, last_activity: null,
      };
      const rawNet = round2(stats.balance);
      const parent = a.parent_id ? byId[String(a.parent_id)] : null;
      return {
        ...json,
        parent_code: parent?.code || null,
        parent_name: parent?.name || null,
        balance: rawNet,
        display_balance: displayBalanceFromNet(a.type, rawNet),
        debit_total: round2(stats.debit_total),
        credit_total: round2(stats.credit_total),
        entry_count: stats.entry_count || 0,
        last_activity: stats.last_activity,
        is_system: STANDARD_CODE_SET.has(a.code),
      };
    })
    .filter((a) => {
      if (!search) return true;
      return a.code.toLowerCase().includes(search)
        || a.name.toLowerCase().includes(search)
        || (a.description || '').toLowerCase().includes(search);
    });

  const posting = rows.filter((a) => !a.is_group);
  const summary = {
    total: rows.length,
    posting: posting.length,
    groups: rows.filter((a) => a.is_group).length,
    with_activity: posting.filter((a) => a.entry_count > 0).length,
    by_type: ['asset', 'liability', 'equity', 'revenue', 'expense'].map((type) => ({
      type,
      count: posting.filter((a) => a.type === type).length,
      balance: round2(
        posting.filter((a) => a.type === type).reduce((s, a) => s + a.display_balance, 0),
      ),
    })),
  };

  return { accounts: rows, summary };
}

async function buildAccountLedger(tenantId, accountId, limit = 100) {
  const account = await Account.findOne({ _id: accountId, tenant_id: tenantId });
  if (!account) return null;

  const entries = await JournalEntry.find({
    tenant_id: tenantId,
    status: { $ne: 'voided' },
    'lines.account_id': account._id,
  }).sort({ entry_date: -1, createdAt: -1 }).limit(limit);

  const lines = [];
  let runningRaw = 0;
  for (const entry of [...entries].reverse()) {
    for (const line of entry.lines) {
      if (String(line.account_id) !== String(account._id)) continue;
      runningRaw += (line.debit || 0) - (line.credit || 0);
      lines.push({
        date: entry.entry_date,
        reference: entry.reference,
        description: line.description || entry.description,
        source: entry.source,
        debit: round2(line.debit || 0),
        credit: round2(line.credit || 0),
        balance_raw: round2(runningRaw),
        balance: displayBalanceFromNet(account.type, runningRaw),
      });
    }
  }

  return {
    account: {
      id: account._id,
      code: account.code,
      name: account.name,
      type: account.type,
      is_group: account.is_group,
      display_balance: displayBalanceFromNet(account.type, runningRaw),
    },
    lines: lines.reverse(),
    totals: {
      debit: round2(lines.reduce((s, l) => s + l.debit, 0)),
      credit: round2(lines.reduce((s, l) => s + l.credit, 0)),
      entries: entries.length,
    },
  };
}

async function seedChartOfAccounts(tenantId) {
  for (const acc of STANDARD_COA) {
    await Account.findOneAndUpdate(
      { tenant_id: tenantId, code: acc.code },
      { tenant_id: tenantId, code: acc.code, name: acc.name, type: acc.type, level: acc.level, is_group: acc.is_group, is_active: true },
      { upsert: true, new: true },
    );
  }
  for (const acc of STANDARD_COA) {
    if (!acc.parent_code) continue;
    const parent = await Account.findOne({ tenant_id: tenantId, code: acc.parent_code });
    if (parent) {
      await Account.updateOne({ tenant_id: tenantId, code: acc.code }, { parent_id: parent._id });
    }
  }
}

async function assertPeriodOpen(tenantId, date) {
  const entryDate = date ? new Date(date) : new Date();
  const closedPeriod = await AccountingPeriod.findOne({
    tenant_id: tenantId,
    status: 'closed',
    start_date: { $lte: entryDate },
    end_date: { $gte: entryDate },
  });
  if (closedPeriod) {
    const err = new Error(`Cannot post to closed period: ${closedPeriod.name}`);
    err.status = 400;
    throw err;
  }
}

async function postJournalEntry(opts) {
  const { tenantId, description, date, lines, source, sourceId, createdBy, reference, skipPeriodCheck } = opts;
  const entryDate = date || new Date();
  if (!skipPeriodCheck) await assertPeriodOpen(tenantId, entryDate);

  const codes = lines.map((l) => l.accountCode);
  const accounts = await Account.find({ tenant_id: tenantId, code: { $in: codes }, is_active: true, is_group: { $ne: true } });
  const accMap = Object.fromEntries(accounts.map((a) => [a.code, a._id]));

  const resolvedLines = lines.map((l) => {
    const account_id = accMap[l.accountCode];
    if (!account_id) throw new Error(`Account code ${l.accountCode} not found for this business.`);
    return {
      account_id,
      debit: round2(l.debit),
      credit: round2(l.credit),
      description: l.description || description,
    };
  });

  const total_debit = round2(resolvedLines.reduce((s, l) => s + l.debit, 0));
  const total_credit = round2(resolvedLines.reduce((s, l) => s + l.credit, 0));

  if (Math.abs(total_debit - total_credit) > 0.01) {
    throw new Error(`Journal entry is unbalanced: debits ${total_debit.toFixed(2)} ≠ credits ${total_credit.toFixed(2)}`);
  }

  const ref = reference || `${String(source || 'manual').toUpperCase().slice(0, 3)}-${Date.now()}`;

  return JournalEntry.create({
    tenant_id: tenantId,
    reference: ref,
    description,
    total_debit,
    total_credit,
    entry_date: entryDate,
    lines: resolvedLines,
    source: source || 'manual',
    source_id: sourceId || null,
    created_by: createdBy || null,
    status: 'posted',
  });
}

async function voidJournalEntry(entryId, tenantId, voidedBy, reason) {
  const entry = await JournalEntry.findOne({ _id: entryId, tenant_id: tenantId });
  if (!entry) throw new Error('Journal entry not found.');
  if (entry.status === 'voided') throw new Error('Entry is already voided.');

  await assertPeriodOpen(tenantId, new Date());

  entry.status = 'voided';
  entry.voided_by = voidedBy;
  entry.voided_at = new Date();
  entry.void_reason = reason || 'Voided by user';
  await entry.save();

  const resolvedLines = entry.lines.map((l) => ({
    account_id: l.account_id,
    debit: l.credit,
    credit: l.debit,
    description: `Reversal: ${l.description || entry.description}`,
  }));

  const total_debit = round2(resolvedLines.reduce((s, l) => s + l.debit, 0));
  const total_credit = round2(resolvedLines.reduce((s, l) => s + l.credit, 0));

  return JournalEntry.create({
    tenant_id: tenantId,
    reference: `VOID-${entry.reference}`,
    description: `Reversal of ${entry.reference}: ${reason || 'Voided'}`,
    total_debit,
    total_credit,
    entry_date: new Date(),
    lines: resolvedLines,
    source: 'manual',
    source_id: entry._id,
    created_by: voidedBy,
    status: 'posted',
  });
}

async function voidJournalEntriesBySource(tenantId, source, sourceId, voidedBy, reason) {
  const entries = await JournalEntry.find({
    tenant_id: tenantId,
    source,
    source_id: sourceId,
    status: 'posted',
  });
  for (const entry of entries) {
    await voidJournalEntry(entry._id, tenantId, voidedBy, reason);
  }
}

async function postSaleEntry({ tenantId, amount, cogsAmount = 0, taxAmount = 0, reference, date, sourceId, createdBy, isCredit = false }) {
  const netRevenue = round2(amount - taxAmount);
  const lines = [];

  if (isCredit) {
    lines.push({ accountCode: '1110', debit: amount, credit: 0, description: `Credit sale ${reference}` });
    lines.push({ accountCode: '4001', debit: 0, credit: netRevenue, description: `Revenue ${reference}` });
    if (taxAmount > 0) lines.push({ accountCode: '2110', debit: 0, credit: taxAmount, description: `VAT collected ${reference}` });
  } else {
    lines.push({ accountCode: '1001', debit: amount, credit: 0, description: `Cash received ${reference}` });
    lines.push({ accountCode: '4001', debit: 0, credit: netRevenue, description: `Revenue ${reference}` });
    if (taxAmount > 0) lines.push({ accountCode: '2110', debit: 0, credit: taxAmount, description: `VAT collected ${reference}` });
  }

  if (cogsAmount > 0) {
    lines.push({ accountCode: '5001', debit: cogsAmount, credit: 0, description: `COGS ${reference}` });
    lines.push({ accountCode: '1120', debit: 0, credit: cogsAmount, description: `Inventory reduction ${reference}` });
  }

  return postJournalEntry({
    tenantId, description: `Sale — ${reference}`, date, lines, source: 'sale', sourceId, createdBy, reference: `SALE-${reference}`,
  });
}

async function postSalePaymentEntry({ tenantId, amount, reference, date, sourceId, createdBy }) {
  return postJournalEntry({
    tenantId,
    description: `Payment received — ${reference}`,
    date,
    lines: [
      { accountCode: '1001', debit: amount, credit: 0, description: `Payment received ${reference}` },
      { accountCode: '1110', debit: 0, credit: amount, description: `AR cleared ${reference}` },
    ],
    source: 'sale', sourceId, createdBy, reference: `PAY-${reference}-${Date.now()}`,
  });
}

async function postExpenseEntry({ tenantId, amount, accountCode = '5200', reference, date, sourceId, createdBy, taxAmount = 0 }) {
  const net = round2(amount - taxAmount);
  const lines = [
    { accountCode, debit: net, credit: 0, description: `Expense ${reference}` },
    { accountCode: '1001', debit: 0, credit: amount, description: `Cash paid ${reference}` },
  ];
  if (taxAmount > 0) {
    lines.splice(1, 0, { accountCode: '1135', debit: taxAmount, credit: 0, description: `VAT input ${reference}` });
  }
  return postJournalEntry({
    tenantId, description: `Expense — ${reference}`, date, lines, source: 'expense', sourceId, createdBy, reference: `EXP-${reference}`,
  });
}

async function postPurchaseOrderEntry({ tenantId, amount, taxAmount = 0, reference, date, sourceId, createdBy }) {
  const net = round2(amount - taxAmount);
  const lines = [
    { accountCode: '1120', debit: net, credit: 0, description: `Goods received ${reference}` },
    { accountCode: '2001', debit: 0, credit: amount, description: `AP created ${reference}` },
  ];
  if (taxAmount > 0) {
    lines.splice(1, 0, { accountCode: '1135', debit: taxAmount, credit: 0, description: `VAT input ${reference}` });
  }
  return postJournalEntry({
    tenantId, description: `Purchase order received — ${reference}`, date, lines, source: 'purchase', sourceId, createdBy, reference: `PO-RCV-${reference}`,
  });
}

async function postPurchasePaymentEntry({ tenantId, amount, reference, date, sourceId, createdBy }) {
  return postJournalEntry({
    tenantId,
    description: `Supplier payment — ${reference}`,
    date,
    lines: [
      { accountCode: '2001', debit: amount, credit: 0, description: `AP cleared ${reference}` },
      { accountCode: '1001', debit: 0, credit: amount, description: `Cash paid ${reference}` },
    ],
    source: 'purchase', sourceId, createdBy, reference: `PO-PAY-${reference}`,
  });
}

async function postVendorBillEntry({ tenantId, amount, taxAmount = 0, expenseAccountCode = '5900', reference, date, sourceId, createdBy }) {
  const net = round2(amount - taxAmount);
  const lines = [
    { accountCode: expenseAccountCode, debit: net, credit: 0, description: `Vendor bill ${reference}` },
    { accountCode: '2001', debit: 0, credit: amount, description: `AP — ${reference}` },
  ];
  if (taxAmount > 0) {
    lines.splice(1, 0, { accountCode: '1135', debit: taxAmount, credit: 0, description: `VAT input ${reference}` });
  }
  return postJournalEntry({
    tenantId, description: `Vendor bill — ${reference}`, date, lines, source: 'purchase', sourceId, createdBy, reference: `BILL-${reference}`,
  });
}

async function postPayrollEntry({
  tenantId,
  grossSalary,
  allowances = 0,
  paye = 0,
  ssnitEmployee = 0,
  ssnitEmployer = 0,
  netSalary,
  reference,
  date,
  sourceId,
  createdBy,
  payFromCash = true,
}) {
  const taxableGross = round2(grossSalary + allowances);
  const totalExpense = round2(taxableGross + ssnitEmployer);
  const lines = [
    { accountCode: '5100', debit: totalExpense, credit: 0, description: `Payroll expense ${reference}` },
  ];

  if (paye > 0) lines.push({ accountCode: '2141', debit: 0, credit: paye, description: `PAYE ${reference}` });
  const ssnitTotal = round2(ssnitEmployee + ssnitEmployer);
  if (ssnitTotal > 0) lines.push({ accountCode: '2140', debit: 0, credit: ssnitTotal, description: `SSNIT ${reference}` });

  if (payFromCash) {
    if (netSalary > 0) lines.push({ accountCode: '1001', debit: 0, credit: netSalary, description: `Net pay ${reference}` });
  } else if (netSalary > 0) {
    lines.push({ accountCode: '2130', debit: 0, credit: netSalary, description: `Salaries payable ${reference}` });
  }

  return postJournalEntry({
    tenantId, description: `Payroll — ${reference}`, date, lines, source: 'payroll', sourceId, createdBy, reference: `PAYROLL-${reference}`,
  });
}

async function postPayrollEntryLegacy({ tenantId, amount, reference, date, sourceId, createdBy }) {
  return postPayrollEntry({
    tenantId, grossSalary: amount, netSalary: amount, reference, date, sourceId, createdBy, payFromCash: true,
  });
}

async function postSaleReturnEntry({ tenantId, amount, cogsAmount = 0, taxAmount = 0, reference, date, sourceId, createdBy }) {
  const netRevenue = round2(amount - taxAmount);
  const lines = [
    { accountCode: '1001', debit: 0, credit: amount, description: `Cash refunded ${reference}` },
    { accountCode: '4001', debit: netRevenue, credit: 0, description: `Revenue reversal ${reference}` },
  ];
  if (taxAmount > 0) lines.push({ accountCode: '2110', debit: taxAmount, credit: 0, description: `VAT reversal ${reference}` });
  if (cogsAmount > 0) {
    lines.push({ accountCode: '1120', debit: cogsAmount, credit: 0, description: `Inventory restored ${reference}` });
    lines.push({ accountCode: '5001', debit: 0, credit: cogsAmount, description: `COGS reversal ${reference}` });
  }
  return postJournalEntry({
    tenantId, description: `Sale return — ${reference}`, date, lines, source: 'sale', sourceId, createdBy, reference: `REF-${reference}`,
  });
}

async function postCreditNoteEntry({ tenantId, amount, taxAmount = 0, reference, date, sourceId, createdBy, refundToCash = true }) {
  const net = round2(amount - taxAmount);
  const lines = [
    { accountCode: '4001', debit: net, credit: 0, description: `Credit note ${reference}` },
  ];
  if (taxAmount > 0) lines.push({ accountCode: '2110', debit: taxAmount, credit: 0, description: `VAT reversal ${reference}` });
  lines.push({
    accountCode: refundToCash ? '1001' : '1110',
    debit: 0,
    credit: amount,
    description: refundToCash ? `Refund ${reference}` : `AR credit ${reference}`,
  });
  return postJournalEntry({
    tenantId, description: `Credit note — ${reference}`, date, lines, source: 'sale', sourceId, createdBy, reference: `CN-${reference}`,
  });
}

async function postAssetAcquisitionEntry({ tenantId, amount, reference, date, sourceId, createdBy, paidFromCash = true }) {
  const lines = [
    { accountCode: '1210', debit: amount, credit: 0, description: `Asset acquisition ${reference}` },
    { accountCode: paidFromCash ? '1001' : '2001', debit: 0, credit: amount, description: `Asset payment ${reference}` },
  ];
  return postJournalEntry({
    tenantId, description: `Fixed asset — ${reference}`, date, lines, source: 'manual', sourceId, createdBy, reference: `ASSET-${reference}`,
  });
}

async function postDepreciationEntry({ tenantId, amount, reference, date, sourceId, createdBy }) {
  return postJournalEntry({
    tenantId,
    description: `Depreciation — ${reference}`,
    date,
    lines: [
      { accountCode: '5500', debit: amount, credit: 0, description: `Depreciation ${reference}` },
      { accountCode: '1220', debit: 0, credit: amount, description: `Accumulated depreciation ${reference}` },
    ],
    source: 'manual', sourceId, createdBy, reference: `DEPR-${reference}`,
  });
}

async function buildGlCashFlow(tenantId, from, to) {
  const cashAcc = await Account.findOne({ tenant_id: tenantId, code: '1001' });
  if (!cashAcc) {
    return {
      operating: { items: [], net: 0 },
      investing: { items: [], net: 0 },
      financing: { items: [], net: 0 },
      opening_balance: 0,
      closing_balance: 0,
      net_change: 0,
      source: 'gl',
    };
  }

  const matchRange = { tenant_id: tenantId, status: { $ne: 'voided' }, 'lines.account_id': cashAcc._id };
  const periodEntryMatch = { tenant_id: tenantId, status: { $ne: 'voided' } };
  if (from || to) {
    matchRange.entry_date = {};
    periodEntryMatch.entry_date = {};
    if (from) {
      matchRange.entry_date.$gte = new Date(from);
      periodEntryMatch.entry_date.$gte = new Date(from);
    }
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      matchRange.entry_date.$lte = end;
      periodEntryMatch.entry_date.$lte = end;
    }
  }

  const openingMatch = { tenant_id: tenantId, status: { $ne: 'voided' }, 'lines.account_id': cashAcc._id };
  if (from) {
    openingMatch.entry_date = { $lt: new Date(from) };
  }

  const [openingAgg, periodRows, ppeActivity, equityActivity] = await Promise.all([
    from
      ? JournalEntry.aggregate([
        { $match: openingMatch },
        { $unwind: '$lines' },
        { $match: { 'lines.account_id': cashAcc._id } },
        { $group: { _id: null, balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
      ])
      : Promise.resolve([{ balance: 0 }]),
    JournalEntry.aggregate([
      { $match: matchRange },
      { $unwind: '$lines' },
      { $match: { 'lines.account_id': cashAcc._id } },
      { $group: { _id: '$source', net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
    JournalEntry.aggregate([
      { $match: periodEntryMatch },
      { $unwind: '$lines' },
      { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
      { $unwind: '$acc' },
      { $match: { 'acc.code': '1210' } },
      { $group: { _id: null, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
    JournalEntry.aggregate([
      { $match: periodEntryMatch },
      { $unwind: '$lines' },
      { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
      { $unwind: '$acc' },
      { $match: { 'acc.code': { $in: ['3001', '2210'] } } },
      { $group: { _id: '$acc.code', name: { $first: '$acc.name' }, net: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
    ]),
  ]);

  const sourceLabels = {
    sale: 'Sales & collections',
    purchase: 'Supplier payments',
    payroll: 'Payroll',
    expense: 'Operating expenses',
    manual: 'Other manual entries',
    opening: 'Opening balances',
    depreciation: 'Depreciation',
    adjustment: 'Adjustments',
  };
  const operatingSources = ['sale', 'purchase', 'payroll', 'expense', 'manual', 'opening', 'depreciation', 'adjustment'];
  const operatingItems = periodRows
    .filter((r) => r._id && operatingSources.includes(r._id))
    .map((r) => ({ label: sourceLabels[r._id] || String(r._id), source: r._id, amount: round2(r.net) }))
    .filter((r) => Math.abs(r.amount) > 0.001);

  const operatingNet = round2(operatingItems.reduce((s, i) => s + i.amount, 0));
  const investingNet = round2(-(ppeActivity[0]?.net || 0));
  const financingItems = equityActivity.map((r) => ({ label: r.name, code: r._id, amount: round2(r.net) }));
  const financingNet = round2(financingItems.reduce((s, i) => s + i.amount, 0));

  const opening_balance = from ? round2(openingAgg[0]?.balance || 0) : 0;
  const net_change = round2(operatingNet + investingNet + financingNet);
  const closing_balance = round2(opening_balance + net_change);

  return {
    source: 'gl',
    operating: { items: operatingItems, net: operatingNet },
    investing: {
      items: Math.abs(investingNet) > 0.001 ? [{ label: 'Property & equipment', amount: investingNet }] : [],
      net: investingNet,
    },
    financing: { items: financingItems, net: financingNet },
    opening_balance,
    net_change,
    closing_balance,
  };
}

function resolveReportDateRange(options = {}) {
  const { from, to, period } = options;
  const now = new Date();

  if (period === 'custom' && !from && !to) {
    return {
      from: null,
      to: null,
      period_key: 'custom',
      period_label: 'Custom range',
      requires_dates: true,
    };
  }

  if (from || to || period === 'custom') {
    return {
      from: from || null,
      to: to || null,
      period_key: 'custom',
      period_label: from && to ? `${from} to ${to}` : from ? `From ${from}` : to ? `Until ${to}` : 'Custom range',
    };
  }

  if (period === 'mtd') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
      from: formatLocalDate(start),
      to: formatLocalDate(now),
      period_key: 'mtd',
      period_label: 'Month to date',
    };
  }

  if (period === 'all') {
    return { from: null, to: null, period_key: 'all', period_label: 'All time' };
  }

  const yearStart = new Date(now.getFullYear(), 0, 1);
  return {
    from: formatLocalDate(yearStart),
    to: formatLocalDate(now),
    period_key: 'ytd',
    period_label: 'Year to date',
  };
}

async function buildCashFlowView(tenantId, options = {}) {
  const range = resolveReportDateRange(options);
  if (range.requires_dates) {
    return {
      empty: true,
      message: 'Select a from and/or to date for a custom range.',
      filters: { from: null, to: null, period: 'custom' },
      period_label: range.period_label,
      generated_at: new Date().toISOString(),
    };
  }

  const report = await buildGlCashFlow(tenantId, range.from, range.to);
  const asOf = range.to ? parseOptionalDate(range.to) : new Date();
  const asOfFilter = asOf ? new Date(asOf) : new Date();
  asOfFilter.setHours(23, 59, 59, 999);
  const glMap = await getGlBalanceMap(tenantId, asOfFilter);
  const glCashBalance = round2(glNet(glMap, '1001'));
  const computedClosing = round2(report.opening_balance + report.net_change);

  return {
    ...report,
    filters: {
      from: range.from,
      to: range.to,
      period: range.period_key,
    },
    period_label: range.period_label,
    generated_at: new Date().toISOString(),
    gl_cash_balance: glCashBalance,
    checks: {
      opening_plus_net: computedClosing,
      closing_reported: report.closing_balance,
      gl_cash_balance: glCashBalance,
      formula_balanced: Math.abs(computedClosing - report.closing_balance) < 0.02,
      matches_gl_cash: Math.abs(computedClosing - glCashBalance) < 0.02,
    },
  };
}

function resolveBudgetPeriod(period, periodType) {
  const now = new Date();
  const defaultPeriod = periodType === 'annual'
    ? String(now.getFullYear())
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const activePeriod = period || defaultPeriod;

  let fromDate;
  let toDate;
  if (periodType === 'annual') {
    fromDate = new Date(`${activePeriod}-01-01T00:00:00`);
    toDate = new Date(`${activePeriod}-12-31T23:59:59.999`);
  } else {
    const [y, m] = activePeriod.split('-').map(Number);
    fromDate = new Date(y, m - 1, 1);
    toDate = new Date(y, m, 0, 23, 59, 59, 999);
  }

  return { activePeriod, fromDate, toDate, periodType: periodType || 'monthly' };
}

async function buildBudgetView(tenantId, options = {}) {
  const periodType = options.period_type === 'annual' ? 'annual' : 'monthly';
  const { activePeriod, fromDate, toDate } = resolveBudgetPeriod(options.period, periodType);

  const [budgets, actuals] = await Promise.all([
    Budget.find({ tenant_id: tenantId, period: activePeriod, period_type: periodType }),
    Expense.aggregate([
      { $match: { tenant_id: tenantId, expense_date: { $gte: fromDate, $lte: toDate } } },
      { $group: { _id: { $ifNull: ['$category', 'Uncategorized'] }, actual: { $sum: '$amount' } } },
    ]),
  ]);

  const actualMap = Object.fromEntries(actuals.map((a) => [a._id, round2(a.actual)]));
  const allCategories = new Set([
    ...budgets.map((b) => b.category),
    ...actuals.map((a) => a._id),
  ]);

  const rows = Array.from(allCategories).map((cat) => {
    const budget = budgets.find((b) => b.category === cat);
    const actual = actualMap[cat] || 0;
    const budgeted = round2(budget?.amount || 0);
    const variance = round2(budgeted - actual);
    const pct = budgeted > 0 ? round2((actual / budgeted) * 100) : null;
    const json = budget?.toJSON?.() || budget;
    return {
      category: cat,
      budgeted,
      actual,
      variance,
      pct,
      budget_id: json?.id || json?._id || null,
      status: budgeted <= 0 ? 'unbudgeted' : actual > budgeted ? 'over' : pct != null && pct >= 80 ? 'warning' : 'ok',
    };
  }).sort((a, b) => b.actual - a.actual || a.category.localeCompare(b.category));

  const totals = rows.reduce(
    (s, r) => ({
      budgeted: round2(s.budgeted + r.budgeted),
      actual: round2(s.actual + r.actual),
      variance: round2(s.variance + r.variance),
    }),
    { budgeted: 0, actual: 0, variance: 0 },
  );

  return {
    period: activePeriod,
    period_type: periodType,
    period_label: periodType === 'annual' ? `Year ${activePeriod}` : activePeriod,
    from: formatLocalDate(fromDate),
    to: formatLocalDate(toDate),
    generated_at: new Date().toISOString(),
    rows,
    totals: {
      ...totals,
      pct: totals.budgeted > 0 ? round2((totals.actual / totals.budgeted) * 100) : null,
    },
    summary: {
      category_count: rows.length,
      budgeted_categories: rows.filter((r) => r.budgeted > 0).length,
      over_budget_count: rows.filter((r) => r.budgeted > 0 && r.actual > r.budgeted).length,
      unbudgeted_spend: round2(rows.filter((r) => r.budgeted <= 0).reduce((s, r) => s + r.actual, 0)),
    },
    categories: EXPENSE_CATEGORIES,
  };
}

async function buildTaxRatesView(tenantId) {
  const rates = await TaxRate.find({ tenant_id: tenantId }).sort('name');
  const rows = rates.map((r) => {
    const json = r.toJSON?.() || r;
    return {
      id: json.id || String(json._id),
      name: json.name,
      rate: round2(json.rate),
      applies_to: json.applies_to || 'both',
      is_active: json.is_active !== false,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    rows,
    summary: {
      total: rows.length,
      active: rows.filter((r) => r.is_active).length,
      inactive: rows.filter((r) => !r.is_active).length,
      sales_rates: rows.filter((r) => r.is_active && (r.applies_to === 'sales' || r.applies_to === 'both')).length,
      purchase_rates: rows.filter((r) => r.is_active && (r.applies_to === 'purchases' || r.applies_to === 'both')).length,
    },
  };
}

function buildJournalDateMatch(tenantId, from, to) {
  const match = { tenant_id: tenantId, status: { $ne: 'voided' } };
  if (from || to) {
    match.entry_date = {};
    if (from) match.entry_date.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      match.entry_date.$lte = end;
    }
  }
  return match;
}

async function buildVatReturnView(tenantId, options = {}) {
  const range = resolveReportDateRange(options);
  if (range.requires_dates) {
    return {
      empty: true,
      message: 'Select a from and/or to date for a custom range.',
      filters: { from: null, to: null, period: 'custom' },
      period_label: range.period_label,
      generated_at: new Date().toISOString(),
    };
  }

  const match = buildJournalDateMatch(tenantId, range.from, range.to);
  const [vatPayable, vatInput] = await Promise.all([
    Account.findOne({ tenant_id: tenantId, code: '2110' }),
    Account.findOne({ tenant_id: tenantId, code: '1135' }),
  ]);

  if (!vatPayable) {
    const err = new Error('VAT Payable account (2110) not found. Seed the chart of accounts first.');
    err.status = 404;
    throw err;
  }

  const outputPipeline = [
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.account_id': vatPayable._id } },
    {
      $group: {
        _id: null,
        credits: { $sum: '$lines.credit' },
        debits: { $sum: '$lines.debit' },
        entries: { $addToSet: '$_id' },
      },
    },
  ];

  const inputPipeline = vatInput ? [
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.account_id': vatInput._id } },
    {
      $group: {
        _id: null,
        debits: { $sum: '$lines.debit' },
        credits: { $sum: '$lines.credit' },
        entries: { $addToSet: '$_id' },
      },
    },
  ] : [];

  const [outputAgg, inputAgg] = await Promise.all([
    JournalEntry.aggregate(outputPipeline),
    inputPipeline.length ? JournalEntry.aggregate(inputPipeline) : Promise.resolve([]),
  ]);

  const outputCredits = round2(outputAgg[0]?.credits || 0);
  const outputDebits = round2(outputAgg[0]?.debits || 0);
  const inputDebits = round2(inputAgg[0]?.debits || 0);
  const inputCredits = round2(inputAgg[0]?.credits || 0);
  const output_vat = round2(outputCredits - outputDebits);
  const input_vat = round2(inputDebits - inputCredits);
  const net_vat_payable = round2(output_vat - input_vat);
  const status = net_vat_payable >= 0 ? 'payable' : 'reclaimable';

  const asOf = range.to ? parseOptionalDate(range.to) : new Date();
  const asOfFilter = asOf ? new Date(asOf) : new Date();
  asOfFilter.setHours(23, 59, 59, 999);
  const glMap = await getGlBalanceMap(tenantId, asOfFilter);
  const gl_vat_payable = round2(-glNet(glMap, '2110'));
  const gl_vat_input = round2(glNet(glMap, '1135'));

  return {
    filters: {
      from: range.from,
      to: range.to,
      period: range.period_key,
    },
    period_label: range.period_label,
    generated_at: new Date().toISOString(),
    accounts: {
      vat_payable_code: '2110',
      vat_payable_name: vatPayable.name,
      vat_input_code: vatInput?.code || '1135',
      vat_input_name: vatInput?.name || 'VAT Input',
      vat_input_configured: !!vatInput,
    },
    output_vat,
    input_vat,
    net_vat_payable,
    status,
    status_label: status === 'payable' ? 'Payable to tax authority' : 'Reclaimable from tax authority',
    breakdown: {
      output: { credits: outputCredits, debits: outputDebits, net: output_vat, entry_count: outputAgg[0]?.entries?.length || 0 },
      input: { debits: inputDebits, credits: inputCredits, net: input_vat, entry_count: inputAgg[0]?.entries?.length || 0 },
    },
    gl_balances: {
      vat_payable: gl_vat_payable,
      vat_input: gl_vat_input,
      as_of: formatLocalDate(asOfFilter),
    },
    checks: {
      vat_input_account_present: !!vatInput,
    },
  };
}

async function buildTaxView(tenantId, options = {}) {
  const [rates, vat] = await Promise.all([
    buildTaxRatesView(tenantId),
    buildVatReturnView(tenantId, options),
  ]);
  return { ...rates, vat };
}

async function buildTrialBalanceView(tenantId, options = {}) {
  const asOfRaw = options.as_of || options.asOf || null;
  const asOfDate = asOfRaw ? parseOptionalDate(asOfRaw) : new Date();
  const asOfFilter = asOfDate ? new Date(asOfDate) : new Date();
  asOfFilter.setHours(23, 59, 59, 999);

  const [accounts, jeBalances] = await Promise.all([
    Account.find({ tenant_id: tenantId, is_active: true, is_group: { $ne: true } }).sort('code'),
    JournalEntry.aggregate([
      { $match: { tenant_id: tenantId, status: { $ne: 'voided' }, entry_date: { $lte: asOfFilter } } },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.account_id', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]),
  ]);

  const balMap = Object.fromEntries(jeBalances.map((b) => [String(b._id), b]));
  const accountsRows = accounts.map((a) => {
    const b = balMap[String(a._id)] || { debit: 0, credit: 0 };
    const net = round2(b.debit - b.credit);
    const debit_balance = net > 0 ? net : 0;
    const credit_balance = net < 0 ? round2(-net) : 0;
    return {
      code: a.code,
      name: a.name,
      type: a.type,
      debit_balance,
      credit_balance,
      net,
    };
  });

  const withBalance = accountsRows.filter((r) => r.debit_balance > 0.001 || r.credit_balance > 0.001);
  const totals = accountsRows.reduce(
    (s, r) => ({
      debit: round2(s.debit + r.debit_balance),
      credit: round2(s.credit + r.credit_balance),
    }),
    { debit: 0, credit: 0 },
  );

  const byType = accountsRows.reduce((map, r) => {
    if (!map[r.type]) map[r.type] = { count: 0, debit: 0, credit: 0 };
    map[r.type].count += 1;
    map[r.type].debit = round2(map[r.type].debit + r.debit_balance);
    map[r.type].credit = round2(map[r.type].credit + r.credit_balance);
    return map;
  }, {});

  return {
    as_of: formatLocalDate(asOfFilter),
    generated_at: new Date().toISOString(),
    accounts: accountsRows,
    totals,
    checks: {
      is_balanced: Math.abs(totals.debit - totals.credit) < 0.02,
      difference: round2(totals.debit - totals.credit),
    },
    summary: {
      account_count: accountsRows.length,
      with_balance: withBalance.length,
      by_type: byType,
    },
  };
}

async function buildInvoicesView(tenantId, options = {}) {
  const { status, customer_id, from, to, search, branchFilter = {} } = options;
  const filter = { tenant_id: tenantId, ...branchFilter };

  if (status) {
    const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (customer_id) filter.customer_id = customer_id;
  if (from || to) {
    filter.issue_date = {};
    if (from) filter.issue_date.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      filter.issue_date.$lte = end;
    }
  }
  if (search) {
    const re = { $regex: String(search).trim(), $options: 'i' };
    filter.$or = [{ invoice_number: re }, { customer_name: re }, { customer_email: re }];
  }

  await Invoice.updateMany(
    { tenant_id: tenantId, status: { $in: ['sent', 'partially_paid'] }, due_date: { $lt: new Date() } },
    { status: 'overdue' },
  );

  const invoices = await Invoice.find(filter).sort({ issue_date: -1 });
  const rows = invoices.map((inv) => {
    const json = inv.toJSON?.() || inv;
    return { ...json, id: json.id || String(json._id) };
  });

  const outstanding = rows.filter((i) => !['paid', 'void', 'draft'].includes(i.status));

  return {
    generated_at: new Date().toISOString(),
    filters: { status: status || null, customer_id: customer_id || null, from: from || null, to: to || null, search: search || null },
    rows,
    invoices: rows,
    summary: {
      count: rows.length,
      draft: rows.filter((i) => i.status === 'draft').length,
      sent: rows.filter((i) => i.status === 'sent').length,
      partially_paid: rows.filter((i) => i.status === 'partially_paid').length,
      paid: rows.filter((i) => i.status === 'paid').length,
      overdue: rows.filter((i) => i.status === 'overdue').length,
      void: rows.filter((i) => i.status === 'void').length,
      total_outstanding: round2(outstanding.reduce((s, i) => s + parseFloat(i.amount_due || 0), 0)),
      total_billed: round2(rows.filter((i) => i.status !== 'void').reduce((s, i) => s + parseFloat(i.total || 0), 0)),
    },
  };
}

async function buildPeriodsView(tenantId) {
  const periods = await AccountingPeriod.find({ tenant_id: tenantId }).sort({ start_date: -1 });
  const rows = periods.map((p) => {
    const json = p.toJSON?.() || p;
    return {
      id: json.id || String(json._id),
      name: json.name,
      type: json.type,
      start_date: json.start_date,
      end_date: json.end_date,
      status: json.status,
      closed_at: json.closed_at || null,
      closed_by: json.closed_by || null,
    };
  });

  const now = new Date();
  const openRows = rows.filter((p) => p.status === 'open');
  const currentOpen = openRows.find((p) => {
    const start = new Date(p.start_date);
    const end = new Date(p.end_date);
    end.setHours(23, 59, 59, 999);
    return start <= now && end >= now;
  }) || openRows[0] || null;

  return {
    generated_at: new Date().toISOString(),
    rows,
    periods: rows,
    summary: {
      total: rows.length,
      open: openRows.length,
      closed: rows.filter((p) => p.status === 'closed').length,
      current_open: currentOpen,
    },
  };
}

async function getGlBalanceMap(tenantId, asOf = null) {
  const match = { tenant_id: tenantId, status: { $ne: 'voided' } };
  if (asOf) match.entry_date = { $lte: asOf };
  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
    { $unwind: '$acc' },
    { $group: {
      _id: { code: '$acc.code', type: '$acc.type', name: '$acc.name', is_group: '$acc.is_group' },
      debit: { $sum: '$lines.debit' },
      credit: { $sum: '$lines.credit' },
    }},
  ]);
  const map = {};
  for (const r of rows) {
    map[r._id.code] = { ...r._id, net: round2(r.debit - r.credit) };
  }
  return map;
}

function glNet(map, code) {
  return map[code]?.net || 0;
}

/** Balance-sheet position from full GL map (all posting accounts, not hardcoded subset). */
function buildPositionFromGlMap(glMap) {
  const gl = (code) => glMap[code]?.net || 0;

  let totalAssets = 0;
  let totalLiabilities = 0;
  let equityAccounts = 0;

  for (const a of Object.values(glMap)) {
    if (a.is_group) continue;
    if (a.type === 'asset') totalAssets += a.net;
    else if (a.type === 'liability') totalLiabilities += (-a.net);
    else if (a.type === 'equity') equityAccounts += (-a.net);
  }

  const revenueBal = Object.values(glMap)
    .filter((a) => a.type === 'revenue' && !a.is_group)
    .reduce((s, a) => s + (-a.net), 0);
  const expenseBal = Object.values(glMap)
    .filter((a) => a.type === 'expense' && !a.is_group)
    .reduce((s, a) => s + a.net, 0);
  const currentNetIncome = round2(revenueBal - expenseBal);

  totalAssets = round2(totalAssets);
  totalLiabilities = round2(totalLiabilities);
  equityAccounts = round2(equityAccounts);
  const totalEquity = round2(equityAccounts + currentNetIncome);

  return {
    cash: gl('1001'),
    accounts_receivable: gl('1110'),
    accounts_payable: round2(-gl('2001')),
    vat_payable: round2(-gl('2110')),
    vat_input: gl('1135'),
    inventory: gl('1120'),
    prepaid: gl('1130'),
    ppe: gl('1210'),
    accumulated_depreciation: gl('1220'),
    salaries_payable: round2(-gl('2130')),
    ssnit_payable: round2(-gl('2140')),
    paye_payable: round2(-gl('2141')),
    total_assets: totalAssets,
    total_liabilities: totalLiabilities,
    total_equity: totalEquity,
    current_net_income: currentNetIncome,
    is_balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.02,
  };
}

function classifyBsSection(type, code) {
  const n = parseInt(code, 10);
  if (Number.isNaN(n)) return 'current';
  if (type === 'asset') return n >= 1200 ? 'non_current' : 'current';
  if (type === 'liability') return n >= 2200 ? 'non_current' : 'current';
  return 'equity';
}

function buildBsLinesFromGlMap(glMap) {
  const assets = { current: [], non_current: [] };
  const liabilities = { current: [], non_current: [] };
  const equity = [];

  for (const acc of Object.values(glMap)) {
    if (acc.is_group) continue;
    if (acc.type === 'revenue' || acc.type === 'expense') continue;
    const amount = acc.type === 'asset' ? round2(acc.net) : round2(-acc.net);
    if (Math.abs(amount) < 0.001) continue;
    const line = { code: acc.code, name: acc.name, amount };
    if (acc.type === 'asset') {
      assets[classifyBsSection('asset', acc.code)].push(line);
    } else if (acc.type === 'liability') {
      liabilities[classifyBsSection('liability', acc.code)].push(line);
    } else if (acc.type === 'equity') {
      equity.push(line);
    }
  }

  const byCode = (a, b) => a.code.localeCompare(b.code);
  assets.current.sort(byCode);
  assets.non_current.sort(byCode);
  liabilities.current.sort(byCode);
  liabilities.non_current.sort(byCode);
  equity.sort(byCode);

  return { assets, liabilities, equity };
}

function sumLineAmounts(lines) {
  return round2((lines || []).reduce((s, l) => s + l.amount, 0));
}

async function buildBalanceSheetView(tenantId, options = {}) {
  const asOfDate = options.as_of ? parseOptionalDate(options.as_of) : new Date();
  const asOfFilter = asOfDate ? new Date(asOfDate) : new Date();
  asOfFilter.setHours(23, 59, 59, 999);

  const [glMap, openInvoices] = await Promise.all([
    getGlBalanceMap(tenantId, asOfFilter),
    Invoice.find({
      tenant_id: tenantId,
      status: { $in: ['sent', 'partially_paid', 'overdue'] },
      amount_due: { $gt: 0.01 },
    }).select('amount_due'),
  ]);

  const position = buildPositionFromGlMap(glMap);
  const gl = (code) => glNet(glMap, code);
  const sections = buildBsLinesFromGlMap(glMap);

  const vatInput = gl('1135');
  const accruedLiab = round2(-gl('2120'));
  const longTermLoans = round2(-gl('2210'));
  const ownerEquity = round2(-gl('3001'));
  const retainedEarnings = round2(-gl('3900'));

  const totalCurrentAssets = sumLineAmounts(sections.assets.current);
  const totalNonCurrentAssets = sumLineAmounts(sections.assets.non_current);
  const totalCurrentLiab = sumLineAmounts(sections.liabilities.current);
  const totalNonCurrentLiab = sumLineAmounts(sections.liabilities.non_current);
  const equityAccountTotal = sumLineAmounts(sections.equity);

  const invoiceArTotal = round2(openInvoices.reduce((s, i) => s + parseFloat(i.amount_due || 0), 0));
  const arGlVsInvoiceDiff = round2(invoiceArTotal - position.accounts_receivable);

  const equityWithIncome = [
    ...sections.equity,
    ...(Math.abs(position.current_net_income) > 0.001
      ? [{ code: 'NI', name: 'Current Period Net Income', amount: position.current_net_income }]
      : []),
  ];

  return {
    source: 'gl',
    as_of: formatLocalDate(asOfFilter),
    as_of_label: formatLocalDate(asOfFilter),
    generated_at: new Date().toISOString(),
    assets: {
      cash: position.cash,
      accounts_receivable: position.accounts_receivable,
      inventory: position.inventory,
      prepaid: position.prepaid,
      vat_input: vatInput,
      ppe: position.ppe,
      accum_depreciation: position.accumulated_depreciation,
      total_current: totalCurrentAssets,
      total_non_current: totalNonCurrentAssets,
      total: position.total_assets,
      lines: sections.assets,
    },
    liabilities: {
      accounts_payable: position.accounts_payable,
      vat_payable: position.vat_payable,
      accrued: accruedLiab,
      salaries_payable: position.salaries_payable,
      ssnit_payable: position.ssnit_payable,
      paye_payable: position.paye_payable,
      long_term_loans: longTermLoans,
      total_current: totalCurrentLiab,
      total_non_current: totalNonCurrentLiab,
      total: position.total_liabilities,
      lines: sections.liabilities,
    },
    equity: {
      owner_equity: ownerEquity,
      retained_earnings: retainedEarnings,
      current_net_income: position.current_net_income,
      account_total: equityAccountTotal,
      total: position.total_equity,
      lines: equityWithIncome,
    },
    is_balanced: position.is_balanced,
    checks: {
      assets_total: position.total_assets,
      liabilities_total: position.total_liabilities,
      equity_total: position.total_equity,
      liabilities_plus_equity: round2(position.total_liabilities + position.total_equity),
      difference: round2(position.total_assets - (position.total_liabilities + position.total_equity)),
    },
    invoice_ar_total: invoiceArTotal,
    ar_gl_vs_invoice_diff: arGlVsInvoiceDiff,
    summary: {
      total_assets: position.total_assets,
      total_liabilities: position.total_liabilities,
      total_equity: position.total_equity,
    },
  };
}

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildPlStatement(report) {
  const operating = report.operating_expenses ?? round2((report.total_expenses || 0) - (report.cogs || 0));
  return [
    { key: 'revenue', label: 'Total Revenue', amount: report.revenue, level: 0 },
    { key: 'cogs', label: 'Cost of Goods Sold', amount: -(report.cogs || 0), level: 1, indent: true },
    { key: 'gross_profit', label: 'Gross Profit', amount: report.gross_profit, level: 0, emphasis: true },
    { key: 'operating_expenses', label: 'Operating Expenses', amount: -operating, level: 1, indent: true },
    { key: 'net_profit', label: 'Net Profit', amount: report.net_profit, level: 0, emphasis: true, total: true },
  ];
}

function buildPlChecks(report) {
  const revenueFromAccounts = round2((report.revenue_by_account || []).reduce((s, r) => s + r.total, 0));
  const expensesFromCategories = round2((report.expenses_by_category || []).reduce((s, e) => s + e.total, 0));
  const expectedNet = round2((report.revenue || 0) - (report.total_expenses || 0));
  return {
    revenue_from_accounts: revenueFromAccounts,
    revenue_matches_accounts: Math.abs(revenueFromAccounts - (report.revenue || 0)) < 0.02,
    expenses_from_categories: expensesFromCategories,
    expenses_match_categories: Math.abs(expensesFromCategories - (report.total_expenses || 0)) < 0.02,
    net_from_formula: expectedNet,
    net_matches_formula: Math.abs(expectedNet - (report.net_profit || 0)) < 0.02,
  };
}

async function buildGlPl(tenantId, from, to) {
  const match = { tenant_id: tenantId, status: { $ne: 'voided' } };
  if (from || to) {
    match.entry_date = {};
    if (from) match.entry_date.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      match.entry_date.$lte = end;
    }
  }
  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
    { $unwind: '$acc' },
    { $match: { 'acc.type': { $in: ['revenue', 'expense'] }, 'acc.is_group': { $ne: true } } },
    { $group: { _id: { type: '$acc.type', code: '$acc.code', name: '$acc.name' }, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);

  let revenue = 0;
  let cogs = 0;
  const expensesByCategory = [];
  const revenueByAccount = [];

  for (const row of rows) {
    if (row._id.type === 'revenue') {
      const amt = round2(row.credit - row.debit);
      revenue += amt;
      if (Math.abs(amt) > 0.001) {
        revenueByAccount.push({ code: row._id.code, name: row._id.name, total: amt });
      }
    } else if (row._id.code === '5001') {
      cogs += round2(row.debit - row.credit);
    } else {
      const amt = round2(row.debit - row.credit);
      if (Math.abs(amt) > 0.001) {
        expensesByCategory.push({ category: row._id.name, code: row._id.code, total: amt });
      }
    }
  }

  revenue = round2(revenue);
  cogs = round2(cogs);
  const operatingExpenses = round2(expensesByCategory.reduce((s, e) => s + e.total, 0));
  const totalExpenses = round2(operatingExpenses + cogs);
  const allExpenses = [...expensesByCategory];
  if (Math.abs(cogs) > 0.001) {
    allExpenses.unshift({ category: 'Cost of Goods Sold', code: '5001', total: cogs });
  }
  allExpenses.sort((a, b) => b.total - a.total);
  revenueByAccount.sort((a, b) => b.total - a.total);

  const grossProfit = round2(revenue - cogs);
  const netProfit = round2(revenue - totalExpenses);

  return {
    source: 'gl',
    revenue,
    cogs,
    gross_profit: grossProfit,
    operating_expenses: operatingExpenses,
    total_expenses: totalExpenses,
    net_profit: netProfit,
    gross_margin_pct: revenue > 0 ? round2((grossProfit / revenue) * 100) : 0,
    net_margin_pct: revenue > 0 ? round2((netProfit / revenue) * 100) : 0,
    expenses_by_category: allExpenses,
    revenue_by_account: revenueByAccount,
    statement: buildPlStatement({
      revenue,
      cogs,
      gross_profit: grossProfit,
      operating_expenses: operatingExpenses,
      total_expenses: totalExpenses,
      net_profit: netProfit,
    }),
    checks: buildPlChecks({
      revenue,
      total_expenses: totalExpenses,
      net_profit: netProfit,
      revenue_by_account: revenueByAccount,
      expenses_by_category: allExpenses,
    }),
  };
}

function resolvePlDateRange(options = {}) {
  const { from, to, period } = options;
  const now = new Date();

  if (period === 'custom' && !from && !to) {
    return {
      from: null,
      to: null,
      period_key: 'custom',
      period_label: 'Custom range',
      requires_dates: true,
    };
  }

  if (from || to || period === 'custom') {
    return {
      from: from || null,
      to: to || null,
      period_key: 'custom',
      period_label: from && to ? `${from} to ${to}` : from ? `From ${from}` : to ? `Until ${to}` : 'Custom range',
    };
  }

  if (period === 'mtd') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return {
      from: formatLocalDate(start),
      to: formatLocalDate(now),
      period_key: 'mtd',
      period_label: 'Month to date',
    };
  }

  if (period === 'all') {
    return { from: null, to: null, period_key: 'all', period_label: 'All time' };
  }

  const yearStart = new Date(now.getFullYear(), 0, 1);
  return {
    from: formatLocalDate(yearStart),
    to: formatLocalDate(now),
    period_key: 'ytd',
    period_label: 'Year to date',
  };
}

async function buildGlMonthlyRevenueInRange(tenantId, from, to) {
  const match = { tenant_id: tenantId, status: { $ne: 'voided' } };
  if (from || to) {
    match.entry_date = {};
    if (from) match.entry_date.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      match.entry_date.$lte = end;
    }
  }

  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
    { $unwind: '$acc' },
    { $match: { 'acc.type': 'revenue', 'acc.is_group': { $ne: true } } },
    { $group: {
      _id: { month: { $month: '$entry_date' }, year: { $year: '$entry_date' } },
      revenue: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } },
    }},
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  return rows.map((r) => ({
    month: MONTH_LABELS[r._id.month] || '',
    year: r._id.year,
    label: `${MONTH_LABELS[r._id.month] || ''} ${r._id.year}`,
    revenue: round2(r.revenue),
  }));
}

async function buildOrdersPl(tenantId, from, to) {
  const match = { tenant_id: tenantId, payment_status: 'paid' };
  const expMatch = { tenant_id: tenantId };
  if (from || to) {
    match.createdAt = {};
    expMatch.expense_date = {};
    if (from) {
      match.createdAt.$gte = new Date(from);
      expMatch.expense_date.$gte = new Date(from);
    }
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      match.createdAt.$lte = end;
      expMatch.expense_date.$lte = end;
    }
  }

  const [rev, cogs, expByCategory, monthly] = await Promise.all([
    Order.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$total' }, subtotal: { $sum: '$subtotal' } } }]),
    Order.aggregate([{ $match: match }, { $group: { _id: null, cogs: { $sum: '$subtotal' } } }]),
    Expense.aggregate([
      { $match: expMatch },
      { $group: { _id: { $ifNull: ['$category', 'Uncategorized'] }, total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
    ]),
    Order.aggregate([
      { $match: match },
      { $group: { _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } }, revenue: { $sum: '$total' } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      { $project: {
        month: { $arrayElemAt: [['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], '$_id.month'] },
        year: '$_id.year',
        label: { $concat: [{ $arrayElemAt: [['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], '$_id.month'] }, ' ', { $toString: '$_id.year' }] },
        revenue: 1,
      } },
    ]),
  ]);

  const revenue = round2(rev[0]?.total || 0);
  const cogsTotal = round2(cogs[0]?.cogs || 0);
  const expensesByCategory = expByCategory.map((e) => ({
    category: e._id,
    total: round2(e.total),
  }));
  const operatingExpenses = round2(expensesByCategory.reduce((s, e) => s + e.total, 0));
  const totalExpenses = round2(operatingExpenses + cogsTotal);
  const grossProfit = round2(revenue - cogsTotal);
  const netProfit = round2(revenue - totalExpenses);
  const allExpenses = [...expensesByCategory];
  if (Math.abs(cogsTotal) > 0.001) {
    allExpenses.unshift({ category: 'Cost of Goods Sold', code: 'COGS', total: cogsTotal });
  }
  allExpenses.sort((a, b) => b.total - a.total);

  const report = {
    source: 'orders',
    revenue,
    cogs: cogsTotal,
    gross_profit: grossProfit,
    operating_expenses: operatingExpenses,
    total_expenses: totalExpenses,
    net_profit: netProfit,
    gross_margin_pct: revenue > 0 ? round2((grossProfit / revenue) * 100) : 0,
    net_margin_pct: revenue > 0 ? round2((netProfit / revenue) * 100) : 0,
    expenses_by_category: allExpenses,
    revenue_by_account: [],
    monthly: monthly.map((m) => ({ ...m, revenue: round2(m.revenue) })),
  };
  report.statement = buildPlStatement(report);
  report.checks = buildPlChecks({ ...report, revenue_by_account: [] });
  return report;
}

async function buildPlView(tenantId, options = {}) {
  const source = options.source === 'orders' ? 'orders' : 'gl';
  const range = resolvePlDateRange(options);

  if (range.requires_dates) {
    return {
      empty: true,
      message: 'Select a from and/or to date for a custom range.',
      filters: { from: null, to: null, source, period: 'custom' },
      period_label: range.period_label,
      generated_at: new Date().toISOString(),
    };
  }

  const report = source === 'orders'
    ? await buildOrdersPl(tenantId, range.from, range.to)
    : await buildGlPl(tenantId, range.from, range.to);

  if (source === 'gl') {
    report.monthly = await buildGlMonthlyRevenueInRange(tenantId, range.from, range.to);
  }

  const monthlyRevenueTotal = round2((report.monthly || []).reduce((s, m) => s + (m.revenue || 0), 0));

  return {
    ...report,
    filters: {
      from: range.from,
      to: range.to,
      source,
      period: range.period_key,
    },
    period_label: range.period_label,
    generated_at: new Date().toISOString(),
    summary: {
      monthly_revenue_total: monthlyRevenueTotal,
      monthly_matches_revenue: report.source === 'gl'
        ? Math.abs(monthlyRevenueTotal - (report.revenue || 0)) < 0.02
        : Math.abs(monthlyRevenueTotal - (report.revenue || 0)) < 0.02,
    },
  };
}

async function buildGlMonthlyRevenue(tenantId, months = 6) {
  const start = new Date();
  start.setMonth(start.getMonth() - (months - 1));
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const rows = await JournalEntry.aggregate([
    { $match: { tenant_id: tenantId, status: { $ne: 'voided' }, entry_date: { $gte: start } } },
    { $unwind: '$lines' },
    { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
    { $unwind: '$acc' },
    { $match: { 'acc.type': 'revenue', 'acc.is_group': { $ne: true } } },
    { $group: {
      _id: { month: { $month: '$entry_date' }, year: { $year: '$entry_date' } },
      revenue: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } },
    }},
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  const byKey = Object.fromEntries(
    rows.map((r) => [`${r._id.year}-${r._id.month}`, round2(r.revenue)]),
  );

  const result = [];
  const cursor = new Date(start);
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  while (cursor <= end) {
    const y = cursor.getFullYear();
    const m = cursor.getMonth() + 1;
    result.push({
      month: MONTH_LABELS[m] || '',
      year: y,
      label: `${MONTH_LABELS[m] || ''} ${y}`,
      revenue: byKey[`${y}-${m}`] || 0,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return result.slice(-months);
}

function buildArAging(invoices) {
  const now = Date.now();
  const buckets = {
    current: { count: 0, amount: 0 },
    days_31_60: { count: 0, amount: 0 },
    days_61_90: { count: 0, amount: 0 },
    over_90: { count: 0, amount: 0 },
  };

  for (const inv of invoices) {
    const due = parseFloat(inv.amount_due || 0);
    if (due <= 0.01) continue;
    const dueDate = new Date(inv.due_date || inv.issue_date).getTime();
    const daysPastDue = Math.max(0, Math.floor((now - dueDate) / 86400000));
    let key = 'current';
    if (daysPastDue > 90) key = 'over_90';
    else if (daysPastDue > 60) key = 'days_61_90';
    else if (daysPastDue > 30) key = 'days_31_60';
    buckets[key].count += 1;
    buckets[key].amount = round2(buckets[key].amount + due);
  }

  const total = Object.values(buckets).reduce(
    (s, b) => ({ count: s.count + b.count, amount: round2(s.amount + b.amount) }),
    { count: 0, amount: 0 },
  );

  return { ...buckets, total };
}

function agingBucketFromDaysPastDue(daysPastDue) {
  if (daysPastDue > 90) return 'over_90';
  if (daysPastDue > 60) return 'days_61_90';
  if (daysPastDue > 30) return 'days_31_60';
  return 'current';
}

function enrichAgingFields(row, dueDateValue) {
  const now = Date.now();
  const dueDate = new Date(dueDateValue || row.entry_date || row.issue_date).getTime();
  const daysPastDue = Math.max(0, Math.floor((now - dueDate) / 86400000));
  return {
    ...row,
    due_date: dueDateValue || row.due_date || null,
    days_past_due: daysPastDue,
    aging_bucket: agingBucketFromDaysPastDue(daysPastDue),
    is_overdue: daysPastDue > 0,
  };
}

async function buildReceivablesView(tenantId, options = {}) {
  const { search, status, aging_bucket: agingFilter, customer_id, branchFilter = {} } = options;

  await Invoice.updateMany(
    { tenant_id: tenantId, status: { $in: ['sent', 'partially_paid'] }, due_date: { $lt: new Date() } },
    { status: 'overdue' },
  );

  const filter = {
    tenant_id: tenantId,
    ...branchFilter,
    status: { $in: ['sent', 'partially_paid', 'overdue'] },
    amount_due: { $gt: 0.01 },
  };
  if (status) {
    const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (customer_id) filter.customer_id = customer_id;

  const invoices = await Invoice.find(filter)
    .populate('customer_id', 'name email phone')
    .sort({ due_date: 1 });

  let rows = invoices.map((inv) => {
    const json = inv.toJSON();
    return enrichAgingFields(
      {
        ...json,
        customer_email: json.customer_email || json.customer_id?.email || null,
      },
      json.due_date,
    );
  });

  if (search) {
    const q = String(search).trim().toLowerCase();
    rows = rows.filter((r) =>
      (r.invoice_number || '').toLowerCase().includes(q)
      || (r.customer_name || '').toLowerCase().includes(q)
      || (r.customer_email || '').toLowerCase().includes(q)
    );
  }
  if (agingFilter) {
    rows = rows.filter((r) => r.aging_bucket === agingFilter);
  }

  const glMap = await getGlBalanceMap(tenantId);
  const glAr = round2(glNet(glMap, '1110'));
  const invoiceTotal = round2(rows.reduce((s, r) => s + parseFloat(r.amount_due || 0), 0));
  const aging = buildArAging(rows);

  return {
    invoices: rows,
    summary: {
      count: rows.length,
      total_outstanding: invoiceTotal,
      overdue_count: rows.filter((r) => r.is_overdue || r.status === 'overdue').length,
      gl_accounts_receivable: glAr,
      gl_vs_invoice_diff: round2(invoiceTotal - glAr),
      aging,
    },
  };
}

async function buildPayablesView(tenantId, options = {}) {
  const { search, source, aging_bucket: agingFilter } = options;

  const apAccount = await Account.findOne({ tenant_id: tenantId, code: '2001' });
  if (!apAccount) {
    return {
      entries: [],
      sources: [
        { value: 'purchase', label: 'Purchase order' },
        { value: 'vendor_bill', label: 'Vendor bill' },
      ],
      summary: {
        count: 0,
        total_outstanding: 0,
        gl_accounts_payable: 0,
        overdue_count: 0,
        aging: buildArAging([]),
      },
    };
  }

  const lines = await JournalEntry.aggregate([
    { $match: { tenant_id: tenantId, status: { $ne: 'voided' } } },
    { $unwind: '$lines' },
    { $match: { 'lines.account_id': apAccount._id } },
    { $group: {
      _id: '$_id',
      reference: { $first: '$reference' },
      description: { $first: '$description' },
      entry_date: { $first: '$entry_date' },
      source: { $first: '$source' },
      source_id: { $first: '$source_id' },
      debit: { $sum: '$lines.debit' },
      credit: { $sum: '$lines.credit' },
    }},
    { $sort: { entry_date: -1 } },
  ]);

  const sourceMap = {};
  for (const l of lines) {
    const key = l.source_id ? String(l.source_id) : String(l._id);
    if (!sourceMap[key]) {
      sourceMap[key] = {
        source_id: l.source_id,
        reference: l.reference,
        description: l.description,
        entry_date: l.entry_date,
        source: l.source,
        debit: 0,
        credit: 0,
      };
    }
    sourceMap[key].debit += l.debit;
    sourceMap[key].credit += l.credit;
  }

  const rawEntries = Object.values(sourceMap)
    .map((e) => ({ ...e, outstanding: round2(e.credit - e.debit) }))
    .filter((e) => e.outstanding > 0.01);

  const poRefs = rawEntries.filter((e) => e.reference?.startsWith('PO-RCV-')).map((e) => e.reference.replace('PO-RCV-', ''));
  const billNumbers = rawEntries.filter((e) => e.reference?.startsWith('BILL-')).map((e) => e.reference.replace('BILL-', ''));
  const billIds = rawEntries.filter((e) => e.source_id).map((e) => e.source_id);

  const [pos, billsById, billsByNumber] = await Promise.all([
    poRefs.length
      ? PurchaseOrder.find({ tenant_id: tenantId, po_number: { $in: poRefs } }).populate('supplier_id', 'name')
      : [],
    billIds.length
      ? VendorBill.find({ tenant_id: tenantId, _id: { $in: billIds } })
      : [],
    billNumbers.length
      ? VendorBill.find({ tenant_id: tenantId, bill_number: { $in: billNumbers } })
      : [],
  ]);

  const poMap = Object.fromEntries(pos.map((p) => [p.po_number, p]));
  const billMap = Object.fromEntries([
    ...billsById.map((b) => [String(b._id), b]),
    ...billsByNumber.map((b) => [String(b._id), b]),
  ]);
  const billByNumber = Object.fromEntries(billsByNumber.map((b) => [b.bill_number, b]));

  let rows = rawEntries.map((e) => {
    let supplier = null;
    let documentNumber = null;
    let documentId = null;
    let documentType = null;
    let dueDate = null;
    let payments = [];

    if (e.reference?.startsWith('PO-RCV-')) {
      const poNum = e.reference.replace('PO-RCV-', '');
      const po = poMap[poNum];
      documentType = 'po';
      documentNumber = po?.po_number || poNum;
      documentId = po?._id || null;
      supplier = po?.supplier_id?.name || null;
      dueDate = po?.expected_date || e.entry_date;
      payments = po?.payments || [];
    } else if (e.reference?.startsWith('BILL-')) {
      const billNum = e.reference.replace('BILL-', '');
      const bill = billByNumber[billNum] || (e.source_id ? billMap[String(e.source_id)] : null);
      documentType = 'vendor_bill';
      documentNumber = bill?.bill_number || billNum;
      documentId = bill?._id || e.source_id || null;
      supplier = bill?.vendor_name || null;
      dueDate = bill?.due_date || e.entry_date;
      payments = bill?.payments || [];
    }

    return enrichAgingFields({
      id: String(e.source_id || e.reference),
      reference: e.reference,
      description: e.description,
      entry_date: e.entry_date,
      source: documentType === 'vendor_bill' ? 'vendor_bill' : 'purchase',
      outstanding: e.outstanding,
      supplier,
      document_number: documentNumber,
      document_id: documentId,
      document_type: documentType,
      payments,
      po_id: documentType === 'po' ? documentId : null,
      po_number: documentType === 'po' ? documentNumber : null,
      bill_id: documentType === 'vendor_bill' ? documentId : null,
      bill_number: documentType === 'vendor_bill' ? documentNumber : null,
    }, dueDate);
  });

  if (source) rows = rows.filter((r) => r.source === source);
  if (search) {
    const q = String(search).trim().toLowerCase();
    rows = rows.filter((r) =>
      (r.reference || '').toLowerCase().includes(q)
      || (r.description || '').toLowerCase().includes(q)
      || (r.supplier || '').toLowerCase().includes(q)
      || (r.document_number || '').toLowerCase().includes(q)
    );
  }
  if (agingFilter) rows = rows.filter((r) => r.aging_bucket === agingFilter);

  rows.sort((a, b) => new Date(b.entry_date) - new Date(a.entry_date));

  const glMap = await getGlBalanceMap(tenantId);
  const glAp = round2(-glNet(glMap, '2001'));
  const totalOutstanding = round2(rows.reduce((s, r) => s + r.outstanding, 0));
  const agingRows = rows.map((r) => ({ amount_due: r.outstanding, due_date: r.due_date }));

  return {
    entries: rows,
    sources: [
      { value: 'purchase', label: 'Purchase order' },
      { value: 'vendor_bill', label: 'Vendor bill' },
    ],
    summary: {
      count: rows.length,
      total_outstanding: totalOutstanding,
      gl_accounts_payable: glAp,
      gl_vs_entries_diff: round2(totalOutstanding - glAp),
      overdue_count: rows.filter((r) => r.is_overdue).length,
      aging: buildArAging(agingRows),
    },
  };
}

const VENDOR_BILL_STATUSES = [
  { value: 'draft', label: 'Draft' },
  { value: 'posted', label: 'Posted' },
  { value: 'partially_paid', label: 'Partially paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];

async function buildVendorBillsView(tenantId, options = {}) {
  const { search, status, aging_bucket: agingFilter, branchFilter = {} } = options;
  const filter = { tenant_id: tenantId, ...branchFilter };
  if (status) {
    const statuses = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }

  const bills = await VendorBill.find(filter)
    .populate('expense_account_id', 'code name')
    .populate('created_by', 'name')
    .sort({ issue_date: -1 });

  const jeIds = bills.filter((b) => b.journal_entry_id).map((b) => b.journal_entry_id);
  const journalEntries = jeIds.length
    ? await JournalEntry.find({ _id: { $in: jeIds } }).select('reference status')
    : [];
  const jeMap = Object.fromEntries(journalEntries.map((j) => [String(j._id), j]));

  let rows = bills.map((b) => {
    const json = b.toJSON();
    const acct = json.expense_account_id && typeof json.expense_account_id === 'object' ? json.expense_account_id : null;
    const je = json.journal_entry_id ? jeMap[String(json.journal_entry_id)] : null;
    return enrichAgingFields({
      ...json,
      expense_account_id: acct?._id || json.expense_account_id || null,
      expense_account_code: acct?.code || '5900',
      expense_account_name: acct?.name || 'Other expenses',
      gl_reference: je?.reference || null,
      gl_status: je?.status || null,
      is_posted: !!je || ['posted', 'partially_paid', 'paid'].includes(json.status),
    }, json.due_date);
  });

  if (search) {
    const q = String(search).trim().toLowerCase();
    rows = rows.filter((r) =>
      (r.bill_number || '').toLowerCase().includes(q)
      || (r.vendor_name || '').toLowerCase().includes(q)
      || (r.gl_reference || '').toLowerCase().includes(q)
      || (r.notes || '').toLowerCase().includes(q)
    );
  }
  if (agingFilter) {
    rows = rows.filter((r) => r.aging_bucket === agingFilter && parseFloat(r.amount_due || 0) > 0.01);
  }

  const openRows = rows.filter((r) => ['posted', 'partially_paid'].includes(r.status) && parseFloat(r.amount_due || 0) > 0.01);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const mtdPosted = rows.filter((r) => r.status !== 'draft' && r.status !== 'void' && new Date(r.issue_date) >= monthStart);

  return {
    bills: rows,
    statuses: VENDOR_BILL_STATUSES,
    summary: {
      count: rows.length,
      draft: rows.filter((r) => r.status === 'draft').length,
      open: openRows.length,
      total_outstanding: round2(openRows.reduce((s, r) => s + parseFloat(r.amount_due || 0), 0)),
      paid: rows.filter((r) => r.status === 'paid').length,
      voided: rows.filter((r) => r.status === 'void').length,
      overdue: openRows.filter((r) => r.is_overdue).length,
      mtd_posted: mtdPosted.length,
      aging: buildArAging(openRows.map((r) => ({ amount_due: r.amount_due, due_date: r.due_date }))),
    },
  };
}

async function buildCreditNotesView(tenantId, options = {}) {
  const { search, status, branchFilter = {} } = options;
  const filter = { tenant_id: tenantId, ...branchFilter };
  if (status) filter.status = status;

  const notes = await CreditNote.find(filter)
    .populate('invoice_id', 'invoice_number customer_name total amount_paid status')
    .populate('created_by', 'name')
    .sort({ createdAt: -1 });

  const cnRefs = notes.map((n) => `CN-${n.credit_note_number}`);
  const journalEntries = cnRefs.length
    ? await JournalEntry.find({ tenant_id: tenantId, reference: { $in: cnRefs }, status: { $ne: 'voided' } }).select('reference status entry_date')
    : [];
  const jeMap = Object.fromEntries(journalEntries.map((j) => [j.reference, j]));

  let rows = notes.map((n) => {
    const json = n.toJSON();
    const inv = json.invoice_id && typeof json.invoice_id === 'object' ? json.invoice_id : null;
    const je = jeMap[`CN-${json.credit_note_number}`];
    return {
      ...json,
      invoice_id: inv?._id || json.invoice_id || null,
      invoice_number: inv?.invoice_number || null,
      invoice_status: inv?.status || null,
      gl_reference: je?.reference || `CN-${json.credit_note_number}`,
      gl_status: je?.status || (json.status === 'applied' ? 'posted' : null),
    };
  });

  if (search) {
    const q = String(search).trim().toLowerCase();
    rows = rows.filter((r) =>
      (r.credit_note_number || '').toLowerCase().includes(q)
      || (r.invoice_number || '').toLowerCase().includes(q)
      || (r.customer_name || '').toLowerCase().includes(q)
      || (r.reason || '').toLowerCase().includes(q)
    );
  }

  const eligibleInvoices = await Invoice.find({
    tenant_id: tenantId,
    status: { $in: ['sent', 'partially_paid', 'paid', 'overdue'] },
    amount_paid: { $gt: 0.01 },
  }).select('invoice_number customer_name amount_paid total status issue_date').sort({ issue_date: -1 });

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const mtd = rows.filter((r) => new Date(r.createdAt) >= monthStart);

  return {
    credit_notes: rows,
    eligible_invoices: eligibleInvoices.map((i) => i.toJSON()),
    summary: {
      count: rows.length,
      total_credited: round2(rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0)),
      mtd_count: mtd.length,
      mtd_amount: round2(mtd.reduce((s, r) => s + parseFloat(r.amount || 0), 0)),
      applied: rows.filter((r) => r.status === 'applied').length,
    },
  };
}

function parseFlexibleDate(value) {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;
  const slash = String(value).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (slash) return new Date(`${slash[3]}-${slash[2]}-${slash[1]}`);
  return null;
}

function daysBetween(a, b) {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

function descriptionScore(a, b) {
  const wa = String(a || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const wb = String(b || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (!wa.length || !wb.length) return 0;
  const setB = new Set(wb);
  return wa.filter((w) => setB.has(w)).length;
}

async function getCashAccount(tenantId, accountId) {
  if (accountId) {
    return Account.findOne({ _id: accountId, tenant_id: tenantId, is_active: true, is_group: { $ne: true } });
  }
  return Account.findOne({ tenant_id: tenantId, code: '1001', is_active: true, is_group: { $ne: true } });
}

async function getCashGlLines(tenantId, cashAccountId, options = {}) {
  const { from, to } = options;
  const match = { tenant_id: tenantId, status: { $ne: 'voided' }, 'lines.account_id': cashAccountId };
  if (from || to) {
    match.entry_date = {};
    if (from) match.entry_date.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      match.entry_date.$lte = end;
    }
  }
  const glEntries = await JournalEntry.find(match).sort({ entry_date: 1 });
  const glLines = [];
  for (const entry of glEntries) {
    for (const line of entry.lines) {
      if (String(line.account_id) === String(cashAccountId)) {
        glLines.push({
          id: String(line._id),
          entry_id: String(entry._id),
          date: entry.entry_date,
          description: line.description || entry.description,
          reference: entry.reference,
          source: entry.source,
          amount: round2((line.debit || 0) - (line.credit || 0)),
        });
      }
    }
  }
  return glLines;
}

function normalizeBankLines(lines) {
  return (lines || []).map((line, i) => {
    const amount = round2(parseFloat(line.amount));
    if (Number.isNaN(amount)) return null;
    return {
      id: line.id ?? i,
      date: line.date || line.transaction_date || '',
      description: line.description || line.memo || line.narration || '',
      amount,
    };
  }).filter(Boolean);
}

function inferDateRange(bankLines) {
  const dates = bankLines.map((l) => parseFlexibleDate(l.date)).filter(Boolean);
  if (!dates.length) return { from: null, to: null };
  dates.sort((a, b) => a - b);
  return {
    from: dates[0].toISOString().slice(0, 10),
    to: dates[dates.length - 1].toISOString().slice(0, 10),
  };
}

function runBankReconciliationMatch(bankLines, glLines) {
  const matched = [];
  const unmatchedBank = [];
  const usedGlIds = new Set();

  for (const bankLine of bankLines) {
    const bankAmt = round2(bankLine.amount);
    const bankDate = parseFlexibleDate(bankLine.date);

    const candidates = glLines
      .filter((g) => !usedGlIds.has(g.id) && Math.abs(g.amount - bankAmt) < 0.01)
      .map((g) => {
        let score = 100;
        if (bankDate) {
          score -= Math.min(daysBetween(bankDate, g.date) * 2, 50);
        }
        score += descriptionScore(bankLine.description, g.description) * 8;
        return { g, score };
      })
      .sort((a, b) => b.score - a.score);

    if (candidates.length) {
      const pick = candidates[0];
      usedGlIds.add(pick.g.id);
      matched.push({ bank: bankLine, gl: pick.g, match_score: pick.score });
    } else {
      unmatchedBank.push(bankLine);
    }
  }

  const unmatchedGl = glLines.filter((g) => !usedGlIds.has(g.id));
  return { matched, unmatchedBank, unmatchedGl };
}

function formatDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseOptionalBalance(value) {
  if (value == null || value === '') return null;
  const n = parseFloat(value);
  return Number.isNaN(n) ? null : round2(n);
}

function parseOptionalDate(value) {
  if (!value) return null;
  const iso = formatDateOnly(value);
  if (!iso) return null;
  return new Date(`${iso}T12:00:00.000Z`);
}

function normalizeStoredBankLines(bankLines) {
  return (bankLines || []).map((line, i) => ({
    line_id: String(line.line_id ?? line.id ?? i),
    date: line.date || '',
    description: line.description || '',
    amount: round2(parseFloat(line.amount)),
    matched: !!line.matched,
    matched_gl_id: line.matched_gl_id ? String(line.matched_gl_id) : undefined,
  }));
}

function normalizeStoredGlLines(glLines) {
  return (glLines || []).map((line) => ({
    gl_line_id: String(line.gl_line_id ?? line.id ?? ''),
    entry_id: line.entry_id ? String(line.entry_id) : undefined,
    date: formatDateOnly(line.date) || line.date || '',
    reference: line.reference || '',
    description: line.description || '',
    source: line.source || '',
    amount: round2(parseFloat(line.amount)),
    matched: !!line.matched,
    matched_bank_line_id: line.matched_bank_line_id ? String(line.matched_bank_line_id) : undefined,
  }));
}

function normalizeStoredMatchedPairs(pairs) {
  return (pairs || []).map((pair) => ({
    bank_line_id: String(pair.bank_line_id ?? pair.bank?.id ?? ''),
    gl_line_id: String(pair.gl_line_id ?? pair.gl?.id ?? ''),
    bank_date: pair.bank_date || pair.bank?.date || '',
    bank_description: pair.bank_description || pair.bank?.description || '',
    bank_amount: pair.bank_amount != null
      ? round2(pair.bank_amount)
      : round2(pair.bank?.amount ?? 0),
    gl_date: formatDateOnly(pair.gl_date || pair.gl?.date) || '',
    gl_reference: pair.gl_reference || pair.gl?.reference || '',
    gl_description: pair.gl_description || pair.gl?.description || '',
    gl_amount: pair.gl_amount != null
      ? round2(pair.gl_amount)
      : round2(pair.gl?.amount ?? 0),
    match_score: pair.match_score ?? undefined,
  }));
}

function deriveReconciliationSessionStats(doc) {
  const json = doc.toJSON ? doc.toJSON() : doc;
  const bankLines = json.bank_lines || [];
  const glLines = json.gl_lines || [];
  const pairs = json.matched_pairs || [];

  const bankLineCount = json.bank_line_count != null ? json.bank_line_count : bankLines.length;
  const glLineCount = json.gl_line_count != null ? json.gl_line_count : glLines.length;
  const matchedFromPairs = pairs.length;
  const matchedFromFlags = bankLines.filter((l) => l.matched).length;
  const matchedCount = json.matched_count != null
    ? json.matched_count
    : Math.max(matchedFromPairs, matchedFromFlags);

  const matchRate = json.match_rate != null
    ? json.match_rate
    : (bankLineCount ? round2((matchedCount / bankLineCount) * 100) : 0);

  const bankTotal = json.bank_total != null
    ? json.bank_total
    : round2(bankLines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0));

  const opening = json.opening_balance;
  const closing = json.closing_balance;
  const hasPersistedSummary = json.bank_line_count != null || json.match_rate != null;

  return {
    ...json,
    statement_date: formatDateOnly(json.statement_date),
    period_from: formatDateOnly(json.period_from),
    period_to: formatDateOnly(json.period_to),
    account_code: doc.account_id?.code || json.account_code || '1001',
    account_name: doc.account_id?.name || json.account_name || 'Cash & Bank',
    bank_line_count: bankLineCount,
    gl_line_count: glLineCount,
    matched_count: matchedCount,
    match_rate: matchRate,
    bank_total: bankTotal,
    gl_period_total: json.gl_period_total,
    period_difference: json.period_difference,
    opening_balance: opening,
    closing_balance: closing,
    has_opening_balance: opening != null && (hasPersistedSummary || opening !== 0),
    has_closing_balance: closing != null && (hasPersistedSummary || closing !== 0),
    completed_by_name: doc.completed_by?.name || json.completed_by_name || null,
  };
}

function buildReconciliationSessionPayload(body = {}, account) {
  const summary = body.summary || {};
  const bankLines = normalizeStoredBankLines(body.bank_lines);
  const glLines = normalizeStoredGlLines(body.gl_lines);
  const matchedPairs = normalizeStoredMatchedPairs(body.matched_pairs);
  const matchedFromFlags = bankLines.filter((l) => l.matched).length;
  const bankLineCount = summary.bank_line_count ?? bankLines.length;
  const glLineCount = summary.gl_line_count ?? glLines.length;
  const matchedCount = summary.matched_count ?? Math.max(matchedPairs.length, matchedFromFlags);
  const matchRate = summary.match_rate ?? (bankLineCount ? round2((matchedCount / bankLineCount) * 100) : 0);
  const bankTotal = summary.bank_total != null
    ? round2(summary.bank_total)
    : round2(bankLines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0));
  const glPeriodTotal = summary.gl_period_total != null
    ? round2(summary.gl_period_total)
    : (glLines.length ? round2(glLines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0)) : null);

  return {
    account_id: account._id,
    statement_date: parseOptionalDate(body.statement_date) || new Date(),
    period_from: parseOptionalDate(body.period_from || body.from),
    period_to: parseOptionalDate(body.period_to || body.to),
    opening_balance: parseOptionalBalance(body.opening_balance),
    closing_balance: parseOptionalBalance(body.closing_balance),
    bank_total: bankTotal,
    gl_period_total: glPeriodTotal,
    bank_line_count: bankLineCount,
    gl_line_count: glLineCount,
    matched_count: matchedCount,
    match_rate: matchRate,
    period_difference: summary.period_difference != null ? round2(summary.period_difference) : null,
    bank_lines: bankLines,
    gl_lines: glLines,
    matched_pairs: matchedPairs,
    notes: body.notes || undefined,
  };
}

async function buildReconciliationView(tenantId) {
  const cashAccount = await getCashAccount(tenantId);
  const glMap = cashAccount ? await getGlBalanceMap(tenantId) : {};
  const glBalance = cashAccount ? round2(glNet(glMap, cashAccount.code)) : 0;

  const sessions = await BankReconciliation.find({ tenant_id: tenantId })
    .sort({ statement_date: -1, createdAt: -1 })
    .limit(25)
    .populate('account_id', 'code name')
    .populate('completed_by', 'name');

  const sessionRows = sessions.map((s) => deriveReconciliationSessionStats(s));

  const completed = sessionRows.filter((s) => s.status === 'completed');
  const lastCompleted = completed[0] || null;

  return {
    cash_account: cashAccount
      ? { id: cashAccount._id, code: cashAccount.code, name: cashAccount.name }
      : null,
    gl_book_balance: glBalance,
    sessions: sessionRows,
    summary: {
      draft_sessions: sessionRows.filter((s) => s.status === 'draft').length,
      completed_sessions: completed.length,
      total_sessions: sessionRows.length,
      last_statement_date: lastCompleted?.statement_date || null,
      gl_book_balance: glBalance,
    },
  };
}

async function executeBankReconciliation(tenantId, options = {}) {
  const {
    lines,
    account_id: accountId,
    from,
    to,
    opening_balance: openingBalance,
    closing_balance: closingBalance,
    statement_date: statementDate,
  } = options;

  const bankLines = normalizeBankLines(lines);
  if (!bankLines.length) {
    const err = new Error('At least one valid bank line with amount is required.');
    err.status = 400;
    throw err;
  }

  const cashAccount = await getCashAccount(tenantId, accountId);
  if (!cashAccount) {
    const err = new Error('Cash & Bank account (1001) not found.');
    err.status = 404;
    throw err;
  }

  const inferred = inferDateRange(bankLines);
  const periodFrom = from || inferred.from;
  const periodTo = to || inferred.to;

  const glLines = await getCashGlLines(tenantId, cashAccount._id, { from: periodFrom, to: periodTo });
  const glMap = await getGlBalanceMap(tenantId);
  const glBookBalance = round2(glNet(glMap, cashAccount.code));

  const { matched, unmatchedBank, unmatchedGl } = runBankReconciliationMatch(bankLines, glLines);

  const bankTotal = round2(bankLines.reduce((s, l) => s + l.amount, 0));
  const glPeriodTotal = round2(glLines.reduce((s, l) => s + l.amount, 0));
  const matchedBankTotal = round2(matched.reduce((s, m) => s + m.bank.amount, 0));
  const matchedGlTotal = round2(matched.reduce((s, m) => s + m.gl.amount, 0));
  const unmatchedBankTotal = round2(unmatchedBank.reduce((s, l) => s + l.amount, 0));
  const unmatchedGlTotal = round2(unmatchedGl.reduce((s, l) => s + l.amount, 0));

  const opening = openingBalance != null && openingBalance !== '' ? round2(parseFloat(openingBalance)) : null;
  const closing = closingBalance != null && closingBalance !== '' ? round2(parseFloat(closingBalance)) : null;
  const computedClosing = opening != null ? round2(opening + bankTotal) : null;
  const closingVariance = closing != null && computedClosing != null ? round2(closing - computedClosing) : null;

  const matchRate = bankLines.length ? round2((matched.length / bankLines.length) * 100) : 0;

  return {
    cash_account: { id: cashAccount._id, code: cashAccount.code, name: cashAccount.name },
    statement_date: statementDate || periodTo || new Date().toISOString().slice(0, 10),
    period: { from: periodFrom, to: periodTo },
    matched,
    unmatchedBank,
    unmatchedGl,
    summary: {
      bank_line_count: bankLines.length,
      gl_line_count: glLines.length,
      matched_count: matched.length,
      match_rate: matchRate,
      bank_total: bankTotal,
      gl_period_total: glPeriodTotal,
      gl_book_balance: glBookBalance,
      matched_bank_total: matchedBankTotal,
      matched_gl_total: matchedGlTotal,
      unmatched_bank_total: unmatchedBankTotal,
      unmatched_gl_total: unmatchedGlTotal,
      opening_balance: opening,
      closing_balance: closing,
      computed_closing: computedClosing,
      closing_variance: closingVariance,
      period_difference: round2(bankTotal - glPeriodTotal),
      is_period_balanced: Math.abs(bankTotal - glPeriodTotal) < 0.02,
      adjusted_gl_balance: round2(glBookBalance - unmatchedGlTotal + unmatchedBankTotal),
    },
  };
}

async function buildReconciliationSessionDetail(tenantId, sessionId) {
  const session = await BankReconciliation.findOne({ _id: sessionId, tenant_id: tenantId })
    .populate('account_id', 'code name')
    .populate('completed_by', 'name');
  if (!session) return null;
  const stats = deriveReconciliationSessionStats(session);
  const bankLines = stats.bank_lines || [];
  const glLines = stats.gl_lines || [];
  const matchedPairs = stats.matched_pairs || [];

  return {
    ...stats,
    matched_pairs: matchedPairs,
    matched_bank_lines: bankLines.filter((l) => l.matched),
    unmatched_bank_lines: bankLines.filter((l) => !l.matched),
    matched_gl_lines: glLines.filter((l) => l.matched),
    unmatched_gl_lines: glLines.filter((l) => !l.matched),
    all_bank_lines: bankLines,
    all_gl_lines: glLines,
  };
}

async function buildAccountingOverview(tenantId, options = {}) {
  const period = options.period || 'ytd';
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let from = null;
  let to = new Date();
  to.setHours(23, 59, 59, 999);
  let periodLabel = 'All time';
  if (period === 'mtd') {
    from = monthStart;
    periodLabel = 'Month to date';
  } else if (period === 'ytd') {
    from = yearStart;
    periodLabel = 'Year to date';
  } else {
    to = null;
  }

  const jePeriodMatch = { tenant_id: tenantId, status: { $ne: 'voided' } };
  if (from || to) {
    jePeriodMatch.entry_date = {};
    if (from) jePeriodMatch.entry_date.$gte = from;
    if (to) jePeriodMatch.entry_date.$lte = to;
  }

  const [
    pl,
    glMap,
    monthlyRevenue,
    openInvoices,
    recentJournal,
    recentExpenses,
    accountRows,
    jeCount,
    jePeriodCount,
    periods,
    overdueCount,
  ] = await Promise.all([
    buildGlPl(tenantId, from, to),
    getGlBalanceMap(tenantId),
    buildGlMonthlyRevenue(tenantId, 6),
    Invoice.find({
      tenant_id: tenantId,
      status: { $in: ['sent', 'partially_paid', 'overdue'] },
      amount_due: { $gt: 0.01 },
    }).select('invoice_number customer_name amount_due due_date issue_date status'),
    JournalEntry.find({ tenant_id: tenantId, status: { $ne: 'voided' } })
      .sort({ entry_date: -1 })
      .limit(8)
      .select('reference description entry_date source status lines'),
    Expense.find({ tenant_id: tenantId })
      .sort({ expense_date: -1 })
      .limit(8)
      .select('title category amount expense_date'),
    Account.find({ tenant_id: tenantId, is_active: true, is_group: { $ne: true } }).select('code name type'),
    JournalEntry.countDocuments({ tenant_id: tenantId, status: { $ne: 'voided' } }),
    JournalEntry.countDocuments(jePeriodMatch),
    AccountingPeriod.find({ tenant_id: tenantId }).sort({ start_date: -1 }).limit(12),
    Invoice.countDocuments({
      tenant_id: tenantId,
      status: { $in: ['sent', 'partially_paid', 'overdue'] },
      amount_due: { $gt: 0.01 },
      due_date: { $lt: now },
    }),
  ]);

  const position = buildPositionFromGlMap(glMap);

  const accountsByType = ['asset', 'liability', 'equity', 'revenue', 'expense'].map((type) => {
    const typed = accountRows.filter((a) => a.type === type);
    let balance = 0;
    if (type === 'revenue') balance = pl.revenue;
    else if (type === 'expense') balance = pl.total_expenses;
    else {
      balance = typed.reduce((s, a) => {
        const net = glNet(glMap, a.code);
        if (type === 'liability' || type === 'equity') return s + (-net);
        return s + net;
      }, 0);
    }
    return { type, count: typed.length, balance: round2(balance), scope: type === 'revenue' || type === 'expense' ? period : 'position' };
  });

  const currentPeriod = periods.find((p) => {
    const start = new Date(p.start_date);
    const end = new Date(p.end_date);
    return p.status === 'open' && start <= now && end >= now;
  }) || periods.find((p) => p.status === 'open') || null;

  const arAging = buildArAging(openInvoices);
  const invoiceArTotal = round2(openInvoices.reduce((s, i) => s + parseFloat(i.amount_due || 0), 0));
  const arGlVsInvoiceDiff = round2(invoiceArTotal - position.accounts_receivable);

  const recentJournalEntries = recentJournal.map((j) => ({
    id: j._id,
    reference: j.reference,
    description: j.description,
    entry_date: j.entry_date,
    source: j.source,
    status: j.status,
    total_debit: round2((j.lines || []).reduce((s, l) => s + (l.debit || 0), 0)),
  }));

  return {
    source: 'gl',
    period,
    period_label: periodLabel,
    as_of: now.toISOString(),
    pl,
    position,
    counts: {
      journal_entries: jeCount,
      journal_entries_in_period: jePeriodCount,
      accounts: accountRows.length,
      open_invoices: openInvoices.length,
      overdue_invoices: overdueCount,
      open_periods: periods.filter((p) => p.status === 'open').length,
    },
    ar_aging: arAging,
    invoice_ar_total: invoiceArTotal,
    ar_gl_vs_invoice_diff: arGlVsInvoiceDiff,
    monthly_revenue: monthlyRevenue,
    expenses_by_category: pl.expenses_by_category,
    recent_journal: recentJournalEntries,
    recent_expenses: recentExpenses,
    current_period: currentPeriod
      ? {
          id: currentPeriod._id,
          name: currentPeriod.name,
          status: currentPeriod.status,
          start_date: currentPeriod.start_date,
          end_date: currentPeriod.end_date,
        }
      : null,
    accounts_by_type: accountsByType,
    // Legacy fields for backward compatibility
    revenue: pl.revenue,
    expenses: pl.total_expenses,
    cogs: pl.cogs,
    gross_profit: pl.gross_profit,
    net_profit: pl.net_profit,
  };
}

const EXPENSE_CATEGORIES = [
  { value: 'office', label: 'Office', account_code: '5200' },
  { value: 'rent', label: 'Rent', account_code: '5300' },
  { value: 'utilities', label: 'Utilities', account_code: '5300' },
  { value: 'marketing', label: 'Marketing', account_code: '5400' },
  { value: 'salaries', label: 'Salaries', account_code: '5100' },
  { value: 'payroll', label: 'Payroll', account_code: '5100' },
  { value: 'cogs', label: 'Cost of Goods Sold', account_code: '5001' },
  { value: 'bank charges', label: 'Bank Charges', account_code: '5600' },
  { value: 'depreciation', label: 'Depreciation', account_code: '5500' },
  { value: 'other', label: 'Other', account_code: '5900' },
];

async function buildExpensesView(tenantId, options = {}) {
  const { from, to, category, search, limit = 500, branchFilter = {} } = options;
  const match = { tenant_id: tenantId, ...branchFilter };
  if (from || to) {
    match.expense_date = {};
    if (from) match.expense_date.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      match.expense_date.$lte = end;
    }
  }
  if (category) match.category = new RegExp(`^${category}$`, 'i');

  const expenses = await Expense.find(match)
    .populate('created_by', 'name')
    .populate('account_id', 'code name type')
    .populate('journal_entry_id', 'reference status entry_date')
    .sort({ expense_date: -1 })
    .limit(limit);

  let rows = expenses.map((e) => {
    const json = e.toJSON();
    const acct = e.account_id && typeof e.account_id === 'object' ? e.account_id : null;
    const je = e.journal_entry_id && typeof e.journal_entry_id === 'object' ? e.journal_entry_id : null;
    return {
      ...json,
      account_id: acct?._id || json.account_id || null,
      account_code: acct?.code || null,
      account_name: acct?.name || null,
      gl_reference: je?.reference || null,
      gl_status: je?.status || null,
      is_posted: !!je || !!json.journal_entry_id,
    };
  });

  if (search) {
    const q = String(search).trim().toLowerCase();
    rows = rows.filter((e) =>
      e.title.toLowerCase().includes(q)
      || (e.category || '').toLowerCase().includes(q)
      || (e.description || '').toLowerCase().includes(q)
      || (e.account_name || '').toLowerCase().includes(q)
      || (e.gl_reference || '').toLowerCase().includes(q)
    );
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  const total = rows.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
  const mtd = rows
    .filter((e) => new Date(e.expense_date) >= monthStart)
    .reduce((s, e) => s + parseFloat(e.amount || 0), 0);
  const ytd = rows
    .filter((e) => new Date(e.expense_date) >= yearStart)
    .reduce((s, e) => s + parseFloat(e.amount || 0), 0);

  const byCategory = {};
  for (const e of rows) {
    const cat = e.category || 'Uncategorized';
    byCategory[cat] = (byCategory[cat] || 0) + parseFloat(e.amount || 0);
  }

  return {
    expenses: rows,
    categories: EXPENSE_CATEGORIES,
    summary: {
      count: rows.length,
      total: round2(total),
      mtd: round2(mtd),
      ytd: round2(ytd),
      with_receipts: rows.filter((e) => e.receipt?.file).length,
      posted: rows.filter((e) => e.is_posted).length,
      unposted: rows.filter((e) => !e.is_posted).length,
      by_category: Object.entries(byCategory)
        .map(([cat, amt]) => ({ category: cat, total: round2(amt) }))
        .sort((a, b) => b.total - a.total),
    },
  };
}

const JOURNAL_SOURCES = [
  { value: 'manual', label: 'Manual' },
  { value: 'sale', label: 'Sale' },
  { value: 'purchase', label: 'Purchase' },
  { value: 'payroll', label: 'Payroll' },
  { value: 'expense', label: 'Expense' },
  { value: 'vendor_bill', label: 'Vendor bill' },
];

function enrichJournalEntry(entry, accMap) {
  const json = entry.toJSON ? entry.toJSON() : entry;
  const enrichedLines = (json.lines || []).map((l) => {
    const acct = accMap[String(l.account_id)] || null;
    return {
      ...l,
      account_code: acct?.code || null,
      account_name: acct?.name || null,
      account_type: acct?.type || null,
    };
  });
  return {
    ...json,
    lines: enrichedLines,
    line_count: enrichedLines.length,
    is_balanced: Math.abs((json.total_debit || 0) - (json.total_credit || 0)) < 0.01,
  };
}

async function buildJournalView(tenantId, options = {}) {
  const { from, to, source, status, search, limit = 500 } = options;
  const match = { tenant_id: tenantId };
  if (from || to) {
    match.entry_date = {};
    if (from) match.entry_date.$gte = new Date(from);
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      match.entry_date.$lte = end;
    }
  }
  if (source) match.source = source;
  if (status) match.status = status;

  const entries = await JournalEntry.find(match)
    .populate('created_by', 'name')
    .populate('voided_by', 'name')
    .sort({ entry_date: -1, createdAt: -1 })
    .limit(limit);

  const accountIds = new Set();
  for (const e of entries) {
    for (const l of e.lines) {
      if (l.account_id) accountIds.add(String(l.account_id));
    }
  }
  const accounts = accountIds.size
    ? await Account.find({ tenant_id: tenantId, _id: { $in: [...accountIds] } }).select('code name type')
    : [];
  const accMap = Object.fromEntries(accounts.map((a) => [String(a._id), a]));

  let rows = entries.map((e) => enrichJournalEntry(e, accMap));

  if (search) {
    const q = String(search).trim().toLowerCase();
    rows = rows.filter((e) =>
      (e.reference || '').toLowerCase().includes(q)
      || (e.description || '').toLowerCase().includes(q)
      || (e.source || '').toLowerCase().includes(q)
      || (e.created_by?.name || '').toLowerCase().includes(q)
      || (e.void_reason || '').toLowerCase().includes(q)
      || (e.lines || []).some((l) =>
        (l.account_code || '').toLowerCase().includes(q)
        || (l.account_name || '').toLowerCase().includes(q)
        || (l.description || '').toLowerCase().includes(q)
      )
    );
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  const postedRows = rows.filter((e) => e.status !== 'voided');
  const voidedRows = rows.filter((e) => e.status === 'voided');

  const bySource = {};
  for (const e of postedRows) {
    const src = e.source || 'manual';
    bySource[src] = (bySource[src] || 0) + 1;
  }

  const sumDebits = (list) => list.reduce((s, e) => s + parseFloat(e.total_debit || 0), 0);
  const mtdPosted = postedRows.filter((e) => new Date(e.entry_date) >= monthStart);
  const ytdPosted = postedRows.filter((e) => new Date(e.entry_date) >= yearStart);

  return {
    entries: rows,
    sources: JOURNAL_SOURCES,
    summary: {
      count: rows.length,
      posted: postedRows.length,
      voided: voidedRows.length,
      total_debit: round2(sumDebits(postedRows)),
      total_credit: round2(sumDebits(postedRows)),
      mtd_count: mtdPosted.length,
      mtd_debit: round2(sumDebits(mtdPosted)),
      ytd_count: ytdPosted.length,
      manual_count: postedRows.filter((e) => e.source === 'manual').length,
      system_count: postedRows.filter((e) => e.source !== 'manual').length,
      by_source: Object.entries(bySource)
        .map(([src, cnt]) => ({
          source: src,
          label: JOURNAL_SOURCES.find((s) => s.value === src)?.label || src,
          count: cnt,
        }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

async function buildJournalEntryDetail(tenantId, entryId) {
  const entry = await JournalEntry.findOne({ _id: entryId, tenant_id: tenantId })
    .populate('created_by', 'name')
    .populate('voided_by', 'name');
  if (!entry) return null;

  const accountIds = entry.lines.map((l) => l.account_id).filter(Boolean);
  const accounts = accountIds.length
    ? await Account.find({ tenant_id: tenantId, _id: { $in: accountIds } }).select('code name type')
    : [];
  const accMap = Object.fromEntries(accounts.map((a) => [String(a._id), a]));
  return enrichJournalEntry(entry, accMap);
}

module.exports = {
  STANDARD_COA,
  seedChartOfAccounts,
  assertPeriodOpen,
  postJournalEntry,
  voidJournalEntry,
  voidJournalEntriesBySource,
  postSaleEntry,
  postSalePaymentEntry,
  postExpenseEntry,
  postPurchaseOrderEntry,
  postPurchasePaymentEntry,
  postVendorBillEntry,
  postPayrollEntry,
  postPayrollEntryLegacy,
  postSaleReturnEntry,
  postCreditNoteEntry,
  postAssetAcquisitionEntry,
  postDepreciationEntry,
  buildGlCashFlow,
  buildCashFlowView,
  buildBudgetView,
  buildTaxRatesView,
  buildVatReturnView,
  buildTaxView,
  buildTrialBalanceView,
  buildInvoicesView,
  buildPeriodsView,
  resolveReportDateRange,
  buildGlPl,
  buildPlView,
  buildOrdersPl,
  buildAccountingOverview,
  buildBalanceSheetView,
  buildPositionFromGlMap,
  buildAccountsCoaView,
  buildAccountLedger,
  postOpeningBalanceEntry,
  postBalanceAdjustmentEntry,
  displayBalanceFromNet,
  isDebitNormalType,
  STANDARD_CODE_SET,
  EXPENSE_CATEGORIES,
  buildExpensesView,
  JOURNAL_SOURCES,
  buildJournalView,
  buildJournalEntryDetail,
  buildReceivablesView,
  buildPayablesView,
  buildVendorBillsView,
  buildCreditNotesView,
  buildReconciliationView,
  buildReconciliationSessionDetail,
  buildReconciliationSessionPayload,
  deriveReconciliationSessionStats,
  executeBankReconciliation,
  formatDateOnly,
  parseOptionalBalance,
  normalizeBankLines,
  round2,
};
