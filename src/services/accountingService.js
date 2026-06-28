const { JournalEntry, Account, AccountingPeriod } = require('../models');

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
  round2,
};
