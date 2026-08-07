const mongoose = require('mongoose');
const {
  Project, ProjectMilestone, ProjectTask, ProjectVariation, ProjectTimeLog,
  Expense, PurchaseOrder, Invoice,
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
      { $group: { _id: null, invoiced: { $sum: '$total' }, paid: { $sum: '$amount_paid' } } },
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

  const progress = round2(project.progress_pct || 0);
  // Value of the work done so far, at contract rates.
  const earned = round2(effectiveContract * (progress / 100));
  const retentionHeld = round2(invoiced * ((project.retention_pct || 0) / 100));

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
    retention_held: retentionHeld,
    // Certified work not yet billed.
    unbilled: round2(Math.max(earned - invoiced, 0)),
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
  milestoneProgress,
  recalculate,
  getFinancials,
  nextCode,
};
