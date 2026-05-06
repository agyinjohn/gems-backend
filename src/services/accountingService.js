const { JournalEntry, Account } = require('../models');

// ── Standard Chart of Accounts ────────────────────────────────────────────────
// level 1 = group header (is_group: true, cannot be posted to)
// level 2 = sub-group   (is_group: true)
// level 3 = posting account (is_group: false)
const STANDARD_COA = [
  // ASSETS
  { code: '1000', name: 'Assets',               type: 'asset',     level: 1, is_group: true,  parent_code: null },
  { code: '1100', name: 'Current Assets',        type: 'asset',     level: 2, is_group: true,  parent_code: '1000' },
  { code: '1001', name: 'Cash & Bank',           type: 'asset',     level: 3, is_group: false, parent_code: '1100' },
  { code: '1110', name: 'Accounts Receivable',   type: 'asset',     level: 3, is_group: false, parent_code: '1100' },
  { code: '1120', name: 'Inventory',             type: 'asset',     level: 3, is_group: false, parent_code: '1100' },
  { code: '1130', name: 'Prepaid Expenses',      type: 'asset',     level: 3, is_group: false, parent_code: '1100' },
  { code: '1200', name: 'Non-Current Assets',    type: 'asset',     level: 2, is_group: true,  parent_code: '1000' },
  { code: '1210', name: 'Property & Equipment',  type: 'asset',     level: 3, is_group: false, parent_code: '1200' },
  { code: '1220', name: 'Accumulated Depreciation', type: 'asset',  level: 3, is_group: false, parent_code: '1200' },
  // LIABILITIES
  { code: '2000', name: 'Liabilities',           type: 'liability', level: 1, is_group: true,  parent_code: null },
  { code: '2100', name: 'Current Liabilities',   type: 'liability', level: 2, is_group: true,  parent_code: '2000' },
  { code: '2001', name: 'Accounts Payable',      type: 'liability', level: 3, is_group: false, parent_code: '2100' },
  { code: '2110', name: 'VAT Payable',           type: 'liability', level: 3, is_group: false, parent_code: '2100' },
  { code: '2120', name: 'Accrued Liabilities',   type: 'liability', level: 3, is_group: false, parent_code: '2100' },
  { code: '2130', name: 'Salaries Payable',      type: 'liability', level: 3, is_group: false, parent_code: '2100' },
  { code: '2200', name: 'Non-Current Liabilities', type: 'liability', level: 2, is_group: true, parent_code: '2000' },
  { code: '2210', name: 'Long-Term Loans',       type: 'liability', level: 3, is_group: false, parent_code: '2200' },
  // EQUITY
  { code: '3000', name: 'Equity',                type: 'equity',    level: 1, is_group: true,  parent_code: null },
  { code: '3001', name: "Owner's Equity",        type: 'equity',    level: 3, is_group: false, parent_code: '3000' },
  { code: '3900', name: 'Retained Earnings',     type: 'equity',    level: 3, is_group: false, parent_code: '3000' },
  // REVENUE
  { code: '4000', name: 'Revenue',               type: 'revenue',   level: 1, is_group: true,  parent_code: null },
  { code: '4001', name: 'Sales Revenue',         type: 'revenue',   level: 3, is_group: false, parent_code: '4000' },
  { code: '4010', name: 'Service Revenue',       type: 'revenue',   level: 3, is_group: false, parent_code: '4000' },
  { code: '4900', name: 'Other Income',          type: 'revenue',   level: 3, is_group: false, parent_code: '4000' },
  // EXPENSES
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

/**
 * Seeds the standard Chart of Accounts for a new tenant.
 * Safe to call multiple times — uses upsert so it won't duplicate.
 */
async function seedChartOfAccounts(tenantId) {
  // First pass: upsert all accounts (without parent_id — codes not yet resolved)
  for (const acc of STANDARD_COA) {
    await Account.findOneAndUpdate(
      { tenant_id: tenantId, code: acc.code },
      { tenant_id: tenantId, code: acc.code, name: acc.name, type: acc.type, level: acc.level, is_group: acc.is_group, is_active: true },
      { upsert: true, new: true }
    );
  }
  // Second pass: resolve parent_id references
  for (const acc of STANDARD_COA) {
    if (!acc.parent_code) continue;
    const parent = await Account.findOne({ tenant_id: tenantId, code: acc.parent_code });
    if (parent) {
      await Account.updateOne({ tenant_id: tenantId, code: acc.code }, { parent_id: parent._id });
    }
  }
}

/**
 * Central GL posting service.
 * ALL financial events must go through here — never write to JournalEntry directly.
 *
 * @param {Object} opts
 * @param {ObjectId} opts.tenantId
 * @param {string}   opts.description
 * @param {Date}     [opts.date]
 * @param {Array}    opts.lines        - [{ accountCode, debit, credit, description }]
 * @param {string}   opts.source       - 'sale'|'purchase'|'payroll'|'expense'|'manual'
 * @param {ObjectId} [opts.sourceId]
 * @param {ObjectId} [opts.createdBy]
 * @param {string}   [opts.reference]  - auto-generated if omitted
 */
async function postJournalEntry(opts) {
  const { tenantId, description, date, lines, source, sourceId, createdBy, reference } = opts;

  // Resolve account codes → ObjectIds
  const codes = lines.map(l => l.accountCode);
  const accounts = await Account.find({ tenant_id: tenantId, code: { $in: codes }, is_active: true });
  const accMap = Object.fromEntries(accounts.map(a => [a.code, a._id]));

  const resolvedLines = lines.map(l => {
    const account_id = accMap[l.accountCode];
    if (!account_id) throw new Error(`Account code ${l.accountCode} not found for this business.`);
    return {
      account_id,
      debit:       parseFloat(l.debit  || 0),
      credit:      parseFloat(l.credit || 0),
      description: l.description || description,
    };
  });

  const total_debit  = resolvedLines.reduce((s, l) => s + l.debit,  0);
  const total_credit = resolvedLines.reduce((s, l) => s + l.credit, 0);

  // Enforce double-entry
  if (Math.abs(total_debit - total_credit) > 0.01) {
    throw new Error(
      `Journal entry is unbalanced: debits ${total_debit.toFixed(2)} ≠ credits ${total_credit.toFixed(2)}`
    );
  }

  const ref = reference || `${source.toUpperCase().slice(0, 3)}-${Date.now()}`;

  return JournalEntry.create({
    tenant_id:    tenantId,
    reference:    ref,
    description,
    total_debit,
    total_credit,
    entry_date:   date || new Date(),
    lines:        resolvedLines,
    source,
    source_id:    sourceId || null,
    created_by:   createdBy || null,
    status:       'posted',
  });
}

/**
 * Void a posted journal entry by creating a reversing entry.
 * The original is marked 'voided' — never deleted.
 */
async function voidJournalEntry(entryId, tenantId, voidedBy, reason) {
  const entry = await JournalEntry.findOne({ _id: entryId, tenant_id: tenantId });
  if (!entry) throw new Error('Journal entry not found.');
  if (entry.status === 'voided') throw new Error('Entry is already voided.');

  entry.status      = 'voided';
  entry.voided_by   = voidedBy;
  entry.voided_at   = new Date();
  entry.void_reason = reason || 'Voided by user';
  await entry.save();

  // Reversing entry — swap debits and credits
  const resolvedLines = entry.lines.map(l => ({
    account_id:  l.account_id,
    debit:       l.credit,
    credit:      l.debit,
    description: `Reversal: ${l.description || entry.description}`,
  }));

  const total_debit  = resolvedLines.reduce((s, l) => s + l.debit,  0);
  const total_credit = resolvedLines.reduce((s, l) => s + l.credit, 0);

  return JournalEntry.create({
    tenant_id:    tenantId,
    reference:    `VOID-${entry.reference}`,
    description:  `Reversal of ${entry.reference}: ${reason || 'Voided'}`,
    total_debit,
    total_credit,
    entry_date:   new Date(),
    lines:        resolvedLines,
    source:       'manual',
    source_id:    entry._id,
    created_by:   voidedBy,
    status:       'posted',
  });
}

// ── Typed event wrappers ──────────────────────────────────────────────────────

async function postSaleEntry({ tenantId, amount, cogsAmount = 0, taxAmount = 0, reference, date, sourceId, createdBy, isCredit = false }) {
  const netRevenue = amount - taxAmount;
  const lines = [];

  if (isCredit) {
    // Credit sale: Dr Accounts Receivable (full amount) / Cr Revenue + Cr VAT Payable
    lines.push({ accountCode: '1110', debit: amount, credit: 0, description: `Credit sale ${reference}` });
    lines.push({ accountCode: '4001', debit: 0, credit: netRevenue, description: `Revenue ${reference}` });
    if (taxAmount > 0) {
      lines.push({ accountCode: '2110', debit: 0, credit: taxAmount, description: `VAT collected ${reference}` });
    }
  } else {
    lines.push({ accountCode: '1001', debit: netRevenue,  credit: 0,           description: `Cash received ${reference}` });
    if (taxAmount > 0) {
      lines.push({ accountCode: '2110', debit: 0,         credit: taxAmount,   description: `VAT collected ${reference}` });
    }
    lines.push({ accountCode: '4001', debit: 0, credit: netRevenue, description: `Revenue ${reference}` });
  }

  if (cogsAmount > 0) {
    lines.push({ accountCode: '5001', debit: cogsAmount, credit: 0,           description: `COGS ${reference}` });
    lines.push({ accountCode: '1120', debit: 0,          credit: cogsAmount,  description: `Inventory reduction ${reference}` });
  }

  return postJournalEntry({
    tenantId, description: `Sale — ${reference}`,
    date, lines, source: 'sale', sourceId, createdBy, reference: `SALE-${reference}`,
  });
}

async function postSalePaymentEntry({ tenantId, amount, reference, date, sourceId, createdBy }) {
  return postJournalEntry({
    tenantId,
    description: `Payment received — ${reference}`,
    date,
    lines: [
      { accountCode: '1001', debit: amount, credit: 0,      description: `Payment received ${reference}` },
      { accountCode: '1110', debit: 0,      credit: amount, description: `AR cleared ${reference}` },
    ],
    source: 'sale', sourceId, createdBy, reference: `PAY-${reference}-${Date.now()}`,
  });
}

async function postExpenseEntry({ tenantId, amount, accountCode = '5200', reference, date, sourceId, createdBy }) {
  return postJournalEntry({
    tenantId,
    description: `Expense — ${reference}`,
    date,
    lines: [
      { accountCode,         debit: amount, credit: 0,      description: `Expense ${reference}` },
      { accountCode: '1001', debit: 0,      credit: amount, description: `Cash paid ${reference}` },
    ],
    source: 'expense', sourceId, createdBy, reference: `EXP-${reference}`,
  });
}

async function postPurchaseOrderEntry({ tenantId, amount, reference, date, sourceId, createdBy }) {
  return postJournalEntry({
    tenantId,
    description: `Purchase order received — ${reference}`,
    date,
    lines: [
      { accountCode: '1120', debit: amount, credit: 0,      description: `Goods received ${reference}` },
      { accountCode: '2001', debit: 0,      credit: amount, description: `AP created ${reference}` },
    ],
    source: 'purchase', sourceId, createdBy, reference: `PO-RCV-${reference}`,
  });
}

async function postPurchasePaymentEntry({ tenantId, amount, reference, date, sourceId, createdBy }) {
  return postJournalEntry({
    tenantId,
    description: `Supplier payment — ${reference}`,
    date,
    lines: [
      { accountCode: '2001', debit: amount, credit: 0,      description: `AP cleared ${reference}` },
      { accountCode: '1001', debit: 0,      credit: amount, description: `Cash paid ${reference}` },
    ],
    source: 'purchase', sourceId, createdBy, reference: `PO-PAY-${reference}`,
  });
}

async function postPayrollEntry({ tenantId, amount, reference, date, sourceId, createdBy }) {
  return postJournalEntry({
    tenantId,
    description: `Payroll — ${reference}`,
    date,
    lines: [
      { accountCode: '5100', debit: amount, credit: 0,      description: `Salary expense ${reference}` },
      { accountCode: '1001', debit: 0,      credit: amount, description: `Cash paid ${reference}` },
    ],
    source: 'payroll', sourceId, createdBy, reference: `PAYROLL-${reference}`,
  });
}

module.exports = {
  seedChartOfAccounts,
  postJournalEntry,
  voidJournalEntry,
  postSaleEntry,
  postSalePaymentEntry,
  postExpenseEntry,
  postPurchaseOrderEntry,
  postPurchasePaymentEntry,
  postPayrollEntry,
};
