const { JournalEntry, Account, AccountingPeriod, Invoice, Expense } = require('../models');

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
    return { operating: { items: [], net: 0 }, investing: { items: [], net: 0 }, financing: { items: [], net: 0 }, opening_balance: 0, closing_balance: 0, net_change: 0, source: 'gl' };
  }

  const matchBefore = { tenant_id: tenantId, status: { $ne: 'voided' }, 'lines.account_id': cashAcc._id };
  const matchRange = { ...matchBefore };
  if (from) matchRange.entry_date = { ...(matchRange.entry_date || {}), $gte: new Date(from) };
  if (to) matchRange.entry_date = { ...(matchRange.entry_date || {}), $lte: new Date(to) };

  const openingMatch = { ...matchBefore };
  if (from) openingMatch.entry_date = { $lt: new Date(from) };

  const [openingAgg, periodRows, ppeActivity, equityActivity] = await Promise.all([
    JournalEntry.aggregate([
      { $match: openingMatch },
      { $unwind: '$lines' },
      { $match: { 'lines.account_id': cashAcc._id } },
      { $group: { _id: null, balance: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
    JournalEntry.aggregate([
      { $match: matchRange },
      { $unwind: '$lines' },
      { $match: { 'lines.account_id': cashAcc._id } },
      { $group: { _id: '$source', net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
    JournalEntry.aggregate([
      { $match: { tenant_id: tenantId, status: { $ne: 'voided' }, ...(from || to ? { entry_date: matchRange.entry_date } : {}) } },
      { $unwind: '$lines' },
      { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
      { $unwind: '$acc' },
      { $match: { 'acc.code': '1210' } },
      { $group: { _id: null, net: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } } } },
    ]),
    JournalEntry.aggregate([
      { $match: { tenant_id: tenantId, status: { $ne: 'voided' }, ...(from || to ? { entry_date: matchRange.entry_date } : {}) } },
      { $unwind: '$lines' },
      { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
      { $unwind: '$acc' },
      { $match: { 'acc.code': { $in: ['3001', '2210'] } } },
      { $group: { _id: '$acc.code', name: { $first: '$acc.name' }, net: { $sum: { $subtract: ['$lines.credit', '$lines.debit'] } } } },
    ]),
  ]);

  const sourceLabels = { sale: 'Sales & collections', purchase: 'Supplier payments', payroll: 'Payroll', expense: 'Operating expenses', manual: 'Other' };
  const operatingItems = periodRows
    .filter((r) => ['sale', 'purchase', 'payroll', 'expense', 'manual'].includes(r._id))
    .map((r) => ({ label: sourceLabels[r._id] || r._id, amount: round2(r.net) }));

  const operatingNet = round2(operatingItems.reduce((s, i) => s + i.amount, 0));
  const investingNet = round2(-(ppeActivity[0]?.net || 0));
  const financingItems = equityActivity.map((r) => ({ label: r.name, code: r._id, amount: round2(r.net) }));
  const financingNet = round2(financingItems.reduce((s, i) => s + i.amount, 0));

  const opening_balance = round2(openingAgg[0]?.balance || 0);
  const net_change = round2(operatingNet + investingNet + financingNet);
  const closing_balance = round2(opening_balance + net_change);

  return {
    source: 'gl',
    operating: { items: operatingItems, net: operatingNet },
    investing: { items: investingNet !== 0 ? [{ label: 'Property & equipment', amount: -investingNet }] : [], net: investingNet },
    financing: { items: financingItems, net: financingNet },
    opening_balance,
    net_change,
    closing_balance,
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

async function buildGlPl(tenantId, from, to) {
  const match = { tenant_id: tenantId, status: { $ne: 'voided' } };
  if (from || to) {
    match.entry_date = {};
    if (from) match.entry_date.$gte = new Date(from);
    if (to) match.entry_date.$lte = new Date(to);
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

  for (const row of rows) {
    if (row._id.type === 'revenue') {
      revenue += row.credit - row.debit;
    } else if (row._id.code === '5001') {
      cogs += row.debit - row.credit;
    } else {
      const amt = row.debit - row.credit;
      if (amt > 0) expensesByCategory.push({ category: row._id.name, code: row._id.code, total: round2(amt) });
    }
  }

  const operatingExpenses = expensesByCategory.reduce((s, e) => s + e.total, 0);
  const totalExpenses = operatingExpenses + cogs;
  const allExpenses = [...expensesByCategory];
  if (cogs > 0) allExpenses.unshift({ category: 'Cost of Goods Sold', code: '5001', total: round2(cogs) });
  allExpenses.sort((a, b) => b.total - a.total);

  return {
    source: 'gl',
    revenue: round2(revenue),
    cogs: round2(cogs),
    gross_profit: round2(revenue - cogs),
    operating_expenses: round2(operatingExpenses),
    total_expenses: round2(totalExpenses),
    net_profit: round2(revenue - totalExpenses),
    expenses_by_category: allExpenses,
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
  const { from, to, category, search, limit = 500 } = options;
  const match = { tenant_id: tenantId };
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
  buildGlPl,
  buildAccountingOverview,
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
  round2,
};
