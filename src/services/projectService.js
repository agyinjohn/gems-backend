const mongoose = require('mongoose');
const {
  Project, ProjectMilestone, ProjectTask, ProjectVariation, ProjectTimeLog,
  ProjectDiary, Expense, PurchaseOrder, Invoice, Tenant, Customer,
} = require('../models');

/**
 * Projects — progress and cost.
 *
 * Everything a decision rests on is derived rather than entered:
 *
 *   progress  = weighted average of milestone completion
 *   contract  = original sum + approved variations
 *   committed = purchase orders raised but not yet expensed
 *   actual    = expenses posted + labour booked + materials issued
 *   earned    = progress × contract
 *
 * A hand-typed "70% complete" is the number that sinks contracts. A weighted
 * one can at least be argued with, and earned-vs-actual is what shows a job
 * losing money while the schedule still looks fine.
 */

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

const oid = (id) => new mongoose.Types.ObjectId(String(id));

/* ── Progress ─────────────────────────────────────────────────────────────── */

/**
 * A milestone's completion.
 *
 * With tasks, it is the weighted share of those done — the milestone can't
 * claim to be further along than its work. Without tasks it keeps whatever was
 * set directly, so simple stage-based plans don't need a task breakdown.
 */
function milestoneProgress(milestone, tasks) {
  if (!tasks.length) {
    return milestone.status === 'completed' ? 100 : round2(milestone.progress_pct || 0);
  }
  const totalWeight = tasks.reduce((sum, t) => sum + (t.weight ?? 1), 0);
  if (totalWeight <= 0) return 0;
  const done = tasks.reduce((sum, t) => {
    const w = t.weight ?? 1;
    if (t.status === 'done') return sum + w;
    if (t.status === 'in_progress') return sum + w * 0.5;
    return sum;
  }, 0);
  return round2((done / totalWeight) * 100);
}

/**
 * Recompute a project's progress from its milestones and persist it.
 *
 * Called after anything that could move the number, so the cached value on the
 * project is never stale. Weightless plans fall back to an even split rather
 * than dividing by zero.
 */
async function recalculate(projectId, tenantId) {
  const [milestones, tasks] = await Promise.all([
    ProjectMilestone.find({ project_id: projectId, tenant_id: tenantId }),
    ProjectTask.find({ project_id: projectId, tenant_id: tenantId }).lean(),
  ]);

  if (!milestones.length) {
    await Project.updateOne({ _id: projectId, tenant_id: tenantId }, { progress_pct: 0 });
    return 0;
  }

  const tasksByMilestone = {};
  for (const t of tasks) {
    const key = String(t.milestone_id || '');
    (tasksByMilestone[key] ||= []).push(t);
  }

  let weighted = 0;
  let totalWeight = 0;
  for (const m of milestones) {
    const own = milestoneProgress(m, tasksByMilestone[String(m._id)] || []);
    // Keep the milestone's own figure current too, so the detail view and the
    // roll-up can't disagree.
    if (round2(m.progress_pct || 0) !== own) {
      m.progress_pct = own;
      if (own >= 100 && m.status !== 'completed') { m.status = 'completed'; m.actual_end ||= new Date(); }
      else if (own > 0 && own < 100 && m.status === 'not_started') { m.status = 'in_progress'; m.actual_start ||= new Date(); }
      await m.save();
    }
    const w = m.weight ?? 1;
    weighted += own * w;
    totalWeight += w;
  }

  const pct = totalWeight > 0 ? round2(weighted / totalWeight) : 0;
  await Project.updateOne({ _id: projectId, tenant_id: tenantId }, { progress_pct: pct });
  return pct;
}

/* ── Money ────────────────────────────────────────────────────────────────── */

/**
 * Cost and contract position for a project.
 *
 * Committed excludes cancelled orders, and counts orders raised whether or not
 * they have been paid — that is the point of committed cost: money promised to
 * suppliers that has not shown up as an expense yet.
 */
async function getFinancials(projectId, tenantId) {
  const project = await Project.findOne({ _id: projectId, tenant_id: tenantId }).lean();
  if (!project) return null;

  const match = { project_id: oid(projectId), tenant_id: oid(tenantId) };

  const [variationRows, expenseRow, poRow, labourRow, invoiceRow] = await Promise.all([
    ProjectVariation.aggregate([
      { $match: match },
      { $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Expense.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    PurchaseOrder.aggregate([
      { $match: { ...match, status: { $nin: ['cancelled', 'draft'] } } },
      { $group: { _id: null, total: { $sum: '$total_cost' } } },
    ]),
    ProjectTimeLog.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$cost' }, hours: { $sum: '$hours' } } },
    ]),
    Invoice.aggregate([
      { $match: { ...match, status: { $ne: 'void' } } },
      { $group: {
        _id: null,
        invoiced: { $sum: '$total' },
        paid: { $sum: '$amount_paid' },
        work_value: { $sum: '$work_value' },
        retention: { $sum: '$retention_amount' },
      } },
    ]),
  ]);

  const byStatus = Object.fromEntries(variationRows.map((r) => [r._id, r.total]));
  const approvedVariations = round2(byStatus.approved || 0);
  const pendingVariations = round2(byStatus.pending || 0);

  const contractValue = round2(project.contract_value || 0);
  // What is actually owed under the contract as it now stands.
  const effectiveContract = round2(contractValue + approvedVariations);

  const budget = round2((project.budget_lines || []).reduce((sum, l) => sum + (l.budget || 0), 0));
  const expenses = round2(expenseRow?.[0]?.total || 0);
  const labour = round2(labourRow?.[0]?.total || 0);
  const actualCost = round2(expenses + labour);
  const committed = round2(poRow?.[0]?.total || 0);

  const invoiced = round2(invoiceRow?.[0]?.invoiced || 0);
  const received = round2(invoiceRow?.[0]?.paid || 0);
  // Gross work certified across applications, and the retention actually
  // withheld on them.
  const certified = round2(invoiceRow?.[0]?.work_value || 0);
  const retentionHeld = round2(invoiceRow?.[0]?.retention || 0);

  const progress = round2(project.progress_pct || 0);
  // Value of the work done so far, at contract rates.
  const earned = round2(effectiveContract * (progress / 100));

  return {
    currency: project.currency || 'GHS',
    contract_value: contractValue,
    approved_variations: approvedVariations,
    pending_variations: pendingVariations,
    effective_contract: effectiveContract,

    budget,
    expenses,
    labour_cost: labour,
    labour_hours: round2(labourRow?.[0]?.hours || 0),
    actual_cost: actualCost,
    committed_cost: committed,
    // What the job is expected to cost if everything already promised lands.
    forecast_cost: round2(actualCost + committed),
    budget_variance: round2(budget - (actualCost + committed)),
    is_over_budget: budget > 0 && actualCost + committed > budget,

    progress_pct: progress,
    earned_value: earned,
    // Positive means the work done has cost less than it is worth.
    margin_to_date: round2(earned - actualCost),

    invoiced,
    received,
    retention_pct: project.retention_pct || 0,
    // Summed from what was actually withheld, not estimated from the invoiced
    // total — otherwise this and the billing position would disagree.
    retention_held: retentionHeld,
    certified_to_date: certified,
    // Work done but not yet certified on an application.
    unbilled: round2(Math.max(earned - certified, 0)),
  };
}

/* ── Progress billing ─────────────────────────────────────────────────────── */

/**
 * The billing position for a project.
 *
 * Construction valuations are cumulative: each application states the gross
 * value of work certified to date, and what falls due is that figure less what
 * has already been certified, less the client's retention. Working cumulatively
 * means a later revaluation corrects itself instead of compounding an error.
 *
 * Retention is tracked in two directions — withheld on each application, and
 * released by separate invoices once the job reaches completion — so the amount
 * still being held by the client is always visible.
 */
async function getBillingPosition(projectId, tenantId) {
  const project = await Project.findOne({ _id: projectId, tenant_id: tenantId }).lean();
  if (!project) return null;

  const match = { project_id: oid(projectId), tenant_id: oid(tenantId), status: { $ne: 'void' } };

  const [rows] = await Promise.all([
    Invoice.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$is_retention_release',
          work_value: { $sum: '$work_value' },
          retention: { $sum: '$retention_amount' },
          total: { $sum: '$total' },
          paid: { $sum: '$amount_paid' },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const progressRow = rows.find((r) => r._id !== true) || {};
  const releaseRow = rows.find((r) => r._id === true) || {};

  const financials = await getFinancials(projectId, tenantId);
  const effectiveContract = financials?.effective_contract || 0;

  const certifiedToDate = round2(progressRow.work_value || 0);
  const retentionHeld = round2(progressRow.retention || 0);
  const retentionReleased = round2(releaseRow.total || 0);

  return {
    currency: project.currency || 'GHS',
    effective_contract: effectiveContract,
    earned_value: financials?.earned_value || 0,
    // Gross work certified across every application so far.
    certified_to_date: certifiedToDate,
    // Can never bill past the contract, variations included.
    remaining_to_certify: round2(Math.max(effectiveContract - certifiedToDate, 0)),
    // Work done but not yet put on an application.
    uncertified_earned: round2(Math.max((financials?.earned_value || 0) - certifiedToDate, 0)),

    retention_pct: project.retention_pct || 0,
    retention_withheld: retentionHeld,
    retention_released: retentionReleased,
    // What the client is still holding.
    retention_outstanding: round2(Math.max(retentionHeld - retentionReleased, 0)),

    invoiced_net: round2((progressRow.total || 0) + (releaseRow.total || 0)),
    received: round2((progressRow.paid || 0) + (releaseRow.paid || 0)),
    applications: progressRow.count || 0,
  };
}

/**
 * A payment certificate for one application.
 *
 * The document a client's quantity surveyor expects, and the reason an invoice
 * on its own isn't enough: a construction valuation is cumulative, so what
 * falls due has to be shown as arithmetic rather than asserted. Gross work to
 * date, less retention, less everything already certified — and the remainder
 * is what this certificate is worth. Stated that way it can be checked and
 * argued with, which is the point of issuing one.
 *
 * Retention releases take the other shape. They bill back money already
 * certified and withheld, so the gross-to-date figures would be nonsense; what
 * matters is how much was held, how much is coming back, and what is left.
 */
async function getPaymentCertificate(projectId, tenantId, invoiceId) {
  const [project, invoice] = await Promise.all([
    Project.findOne({ _id: projectId, tenant_id: tenantId }).lean(),
    Invoice.findOne({ _id: invoiceId, project_id: projectId, tenant_id: tenantId }).lean(),
  ]);
  if (!project || !invoice) return null;
  if (invoice.status === 'void') return { error: 'This invoice has been voided, so it cannot be certified.' };

  const [tenant, customer, siblings, financials] = await Promise.all([
    Tenant.findById(tenantId).select('business_name address phone email logo').lean(),
    project.customer_id
      ? Customer.findOne({ _id: project.customer_id, tenant_id: tenantId }).select('name company address phone email').lean()
      : null,
    Invoice.find({ project_id: projectId, tenant_id: tenantId, status: { $ne: 'void' } })
      .select('invoice_number issue_date work_value retention_amount total is_retention_release createdAt')
      .lean(),
    getFinancials(projectId, tenantId),
  ]);

  // Certificates are numbered and accumulated in the order they were issued,
  // not the order they happen to come back from the database.
  const inOrder = siblings.sort((a, b) => {
    const d = new Date(a.issue_date || a.createdAt) - new Date(b.issue_date || b.createdAt);
    return d !== 0 ? d : String(a._id).localeCompare(String(b._id));
  });

  const isRelease = !!invoice.is_retention_release;
  const sameKind = inOrder.filter((i) => !!i.is_retention_release === isRelease);
  const position = sameKind.findIndex((i) => String(i._id) === String(invoice._id));
  const priorSameKind = sameKind.slice(0, Math.max(position, 0));

  const header = {
    certificate_no: position >= 0 ? position + 1 : sameKind.length,
    type: isRelease ? 'retention_release' : 'interim',
    title: isRelease ? 'Certificate for Release of Retention' : 'Interim Payment Certificate',
    issued_on: invoice.issue_date,
    due_on: invoice.due_date,
    invoice_number: invoice.invoice_number,
    status: invoice.status,
    amount_paid: round2(invoice.amount_paid || 0),
    balance_outstanding: round2((invoice.total || 0) - (invoice.amount_paid || 0)),
    notes: invoice.notes || '',
  };

  const parties = {
    contractor: {
      name: tenant?.business_name || '',
      address: tenant?.address || '',
      phone: tenant?.phone || '',
      email: tenant?.email || '',
      logo: tenant?.logo || '',
    },
    employer: {
      name: customer?.company || customer?.name || project.customer_name || '',
      contact: customer?.company ? customer?.name : '',
      address: customer?.address || '',
      phone: customer?.phone || '',
      email: customer?.email || '',
    },
  };

  const contract = {
    project_name: project.name,
    project_code: project.code,
    site_address: project.site_address || '',
    currency: project.currency || 'GHS',
    original_sum: round2(project.contract_value || 0),
    approved_variations: round2(financials?.approved_variations || 0),
    adjusted_sum: round2(financials?.effective_contract || 0),
    retention_pct: project.retention_pct || 0,
    start_date: project.start_date || null,
    planned_end_date: project.planned_end_date || null,
  };

  if (isRelease) {
    // Everything withheld across every application, and everything given back
    // before this certificate.
    const withheldToDate = round2(inOrder.reduce((s, i) => s + (i.retention_amount || 0), 0));
    const releasedBefore = round2(priorSameKind.reduce((s, i) => s + (i.total || 0), 0));
    const nowDue = round2(invoice.total || 0);

    return {
      ...header,
      parties,
      contract,
      valuation: {
        retention_withheld_to_date: withheldToDate,
        previously_released: releasedBefore,
        retention_held_before_this: round2(withheldToDate - releasedBefore),
        amount_now_due: nowDue,
        retention_still_held: round2(Math.max(withheldToDate - releasedBefore - nowDue, 0)),
      },
      lines: invoice.lines || [],
    };
  }

  const grossToDate = round2(sameKind.slice(0, position + 1).reduce((s, i) => s + (i.work_value || 0), 0));
  const retentionToDate = round2(sameKind.slice(0, position + 1).reduce((s, i) => s + (i.retention_amount || 0), 0));
  const netToDate = round2(grossToDate - retentionToDate);
  const previouslyCertified = round2(priorSameKind.reduce((s, i) => s + (i.total || 0), 0));
  const nowDue = round2(netToDate - previouslyCertified);

  return {
    ...header,
    parties,
    contract,
    valuation: {
      gross_value_to_date: grossToDate,
      // Work certified on this application alone — the movement since the last.
      value_this_certificate: round2(invoice.work_value || 0),
      retention_pct: project.retention_pct || 0,
      retention_to_date: retentionToDate,
      retention_this_certificate: round2(invoice.retention_amount || 0),
      net_value_to_date: netToDate,
      previously_certified: previouslyCertified,
      amount_now_due: nowDue,
      // Percentage of the adjusted contract certified so far, which is the
      // figure both sides argue about.
      certified_pct: contract.adjusted_sum > 0 ? round2((grossToDate / contract.adjusted_sum) * 100) : 0,
      remaining_to_certify: round2(Math.max(contract.adjusted_sum - grossToDate, 0)),
    },
    lines: invoice.lines || [],
  };
}

/* ── Site records ─────────────────────────────────────────────────────────── */

/**
 * Totals across the site diary.
 *
 * Lost time is broken down by cause because that is the form an
 * extension-of-time claim takes: it is not enough to show a job ran late, it
 * has to be attributable. Weather is separated out since it is usually the
 * ground for an extension without additional cost, while client instructions
 * and access typically carry cost too.
 */
async function getDiarySummary(projectId, tenantId) {
  const match = { project_id: oid(projectId), tenant_id: oid(tenantId) };

  const [totals, byCause, weatherDays] = await Promise.all([
    ProjectDiary.aggregate([
      { $match: match },
      { $group: {
        _id: null,
        entries: { $sum: 1 },
        non_working: { $sum: { $cond: [{ $eq: ['$worked', false] }, 1, 0] } },
        labour_days: { $sum: '$labour_count' },
      } },
    ]),
    ProjectDiary.aggregate([
      { $match: match },
      { $unwind: '$delays' },
      { $group: { _id: '$delays.cause', hours: { $sum: '$delays.hours_lost' }, occurrences: { $sum: 1 } } },
      { $sort: { hours: -1 } },
    ]),
    ProjectDiary.aggregate([
      { $match: { ...match, weather: { $in: ['heavy_rain', 'storm'] } } },
      { $count: 'days' },
    ]),
  ]);

  const causes = byCause.map((c) => ({ cause: c._id, hours: round2(c.hours), occurrences: c.occurrences }));

  return {
    entries: totals?.[0]?.entries || 0,
    non_working_days: totals?.[0]?.non_working || 0,
    labour_days: totals?.[0]?.labour_days || 0,
    severe_weather_days: weatherDays?.[0]?.days || 0,
    hours_lost: round2(causes.reduce((sum, c) => sum + c.hours, 0)),
    hours_lost_by_cause: causes,
    weather_hours_lost: round2(causes.find((c) => c.cause === 'weather')?.hours || 0),
  };
}

/** Next project code for a tenant, e.g. PRJ-0007. */
async function nextCode(tenantId) {
  const last = await Project.findOne({ tenant_id: tenantId }).sort({ createdAt: -1 }).select('code').lean();
  const n = parseInt(String(last?.code || '').replace(/\D/g, ''), 10);
  return `PRJ-${String(Number.isFinite(n) ? n + 1 : 1).padStart(4, '0')}`;
}

module.exports = {
  round2,
  getBillingPosition,
  getDiarySummary,
  milestoneProgress,
  recalculate,
  getFinancials,
  getPaymentCertificate,
  nextCode,
};
