const {
  Project, ProjectMilestone, ProjectBaseline, PurchaseOrder, Invoice,
} = require('../models');
const projectService = require('./projectService');

/**
 * Projects — looking forward rather than back.
 *
 * Two questions a contractor cannot answer from the ledger:
 *
 *   "Are we behind, and by how much?"   — needs a frozen programme to measure
 *                                         against, since live dates get edited.
 *   "When do we run out of money?"      — needs the timing of money in and out,
 *                                         not just the totals.
 *
 * The second is what actually kills building firms. A job can be profitable on
 * paper for its whole life and still fail, because the work is paid for months
 * before the client pays for it. What matters is the deepest point of the
 * cumulative curve — the working capital the job demands before it starts
 * giving any back.
 */

const { round2 } = projectService;

const MS_DAY = 86400000;

const toDate = (d) => (d ? new Date(d) : null);
const addDays = (d, n) => new Date(new Date(d).getTime() + n * MS_DAY);
const daysBetween = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / MS_DAY);

/** First instant of a month, in UTC, so bucketing can't drift with the server's zone. */
function startOfMonth(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1));
}
/** Month arithmetic from the 1st, which avoids the Jan-31-plus-one-month trap. */
function addMonths(d, n) {
  const x = startOfMonth(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n, 1));
}
/** Last instant of the month containing d. */
function endOfMonth(d) {
  return new Date(addMonths(d, 1).getTime() - 1);
}
const monthKey = (d) => {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
};
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (d) => {
  const x = new Date(d);
  return `${MONTH_NAMES[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};

/* ── Baseline & schedule variance ─────────────────────────────────────────── */

/**
 * How much of a baseline milestone should be finished by a given moment.
 *
 * Dated at both ends it ramps evenly across the span, which is the usual
 * assumption behind a planned-value curve. Dated only at the end it is treated
 * as a step — nothing, then all of it — because a stage with no start date says
 * nothing about when its work was meant to happen. Undated work contributes
 * nothing to the planned figure at all; guessing would quietly invent progress
 * that was never scheduled.
 */
function plannedFractionAt(bm, asOf) {
  const end = toDate(bm.planned_end);
  if (!end) return 0;
  if (asOf.getTime() >= end.getTime()) return 1;
  const start = toDate(bm.planned_start);
  if (!start || start.getTime() >= end.getTime()) return 0;
  if (asOf.getTime() <= start.getTime()) return 0;
  return (asOf.getTime() - start.getTime()) / (end.getTime() - start.getTime());
}

/** Weighted percentage of the baseline that should be complete by asOf. */
function plannedPctAt(baselineMilestones, asOf) {
  const totalWeight = baselineMilestones.reduce((s, m) => s + (m.weight ?? 1), 0);
  if (totalWeight <= 0) return 0;
  const done = baselineMilestones.reduce((s, m) => s + (m.weight ?? 1) * plannedFractionAt(m, asOf), 0);
  return round2((done / totalWeight) * 100);
}

/** Weighted percentage of live milestones actually finished by asOf. */
function actualPctAt(milestones, asOf) {
  const totalWeight = milestones.reduce((s, m) => s + (m.weight ?? 1), 0);
  if (totalWeight <= 0) return 0;
  const done = milestones.reduce((s, m) => {
    const end = toDate(m.actual_end);
    return end && end.getTime() <= asOf.getTime() ? s + (m.weight ?? 1) : s;
  }, 0);
  return round2((done / totalWeight) * 100);
}

/**
 * Freeze the current programme as a new baseline version.
 *
 * The previous version is stood down rather than deleted. A job that has been
 * re-baselined three times has a history worth keeping: it is the record of
 * what was agreed and when it changed, and an extension of time is argued
 * against the version it was granted from.
 */
async function setBaseline(projectId, tenantId, { name, reason, userId } = {}) {
  const project = await Project.findOne({ _id: projectId, tenant_id: tenantId }).lean();
  if (!project) return null;

  const [milestones, financials, last] = await Promise.all([
    ProjectMilestone.find({ project_id: projectId, tenant_id: tenantId }).sort({ sequence: 1, createdAt: 1 }).lean(),
    projectService.getFinancials(projectId, tenantId),
    ProjectBaseline.findOne({ project_id: projectId, tenant_id: tenantId }).sort({ version: -1 }).select('version').lean(),
  ]);

  const version = (last?.version || 0) + 1;

  // Stand the old one down first. The unique partial index permits only one
  // current baseline per project, so creating before clearing would collide.
  await ProjectBaseline.updateMany(
    { project_id: projectId, tenant_id: tenantId, is_current: true },
    { $set: { is_current: false } },
  );

  return ProjectBaseline.create({
    tenant_id: tenantId,
    project_id: projectId,
    version,
    name: name?.trim() || (version === 1 ? 'Award programme' : `Revision ${version}`),
    reason: reason?.trim() || undefined,
    start_date: project.start_date || null,
    planned_end_date: project.planned_end_date || null,
    contract_value: financials?.effective_contract || project.contract_value || 0,
    milestones: milestones.map((m) => ({
      milestone_id: m._id,
      name: m.name,
      weight: m.weight ?? 1,
      planned_start: m.planned_start || null,
      planned_end: m.planned_end || null,
      billable_amount: m.billable_amount || 0,
    })),
    is_current: true,
    set_by: userId || null,
  });
}

/**
 * Progress measured against the frozen programme.
 *
 * SPI is earned value over planned value. Both are taken against the baseline
 * contract sum rather than the current one, so approving a variation doesn't
 * silently move the yardstick and make a late job look recovered.
 */
async function getScheduleVariance(projectId, tenantId, asOf = new Date()) {
  const project = await Project.findOne({ _id: projectId, tenant_id: tenantId }).lean();
  if (!project) return null;

  const [baseline, milestones] = await Promise.all([
    ProjectBaseline.findOne({ project_id: projectId, tenant_id: tenantId, is_current: true }).lean(),
    ProjectMilestone.find({ project_id: projectId, tenant_id: tenantId }).sort({ sequence: 1, createdAt: 1 }).lean(),
  ]);

  const actualPct = round2(project.progress_pct || 0);

  if (!baseline) {
    return {
      has_baseline: false,
      currency: project.currency || 'GHS',
      actual_pct: actualPct,
      milestones: [],
      curve: [],
    };
  }

  const bac = round2(baseline.contract_value || 0);
  const plannedPct = plannedPctAt(baseline.milestones || [], asOf);
  const plannedValue = round2(bac * (plannedPct / 100));
  const earnedValue = round2(bac * (actualPct / 100));
  const spi = plannedPct > 0 ? round2(actualPct / plannedPct) : null;

  const liveById = new Map(milestones.map((m) => [String(m._id), m]));
  const baselineIds = new Set((baseline.milestones || []).map((m) => String(m.milestone_id)));

  const rows = (baseline.milestones || []).map((bm) => {
    const live = liveById.get(String(bm.milestone_id));
    const baselineEnd = toDate(bm.planned_end);
    const currentEnd = live ? toDate(live.planned_end) : null;
    const actualEnd = live ? toDate(live.actual_end) : null;
    const complete = live?.status === 'completed';

    return {
      milestone_id: String(bm.milestone_id),
      name: live?.name || bm.name,
      // Renamed since the baseline was taken — worth surfacing, since a stage
      // quietly renamed is often a stage quietly redefined.
      renamed_from: live && live.name !== bm.name ? bm.name : null,
      removed: !live,
      weight: bm.weight ?? 1,
      baseline_start: bm.planned_start || null,
      baseline_end: bm.planned_end || null,
      current_end: live?.planned_end || null,
      actual_end: live?.actual_end || null,
      status: live?.status || 'removed',
      progress_pct: round2(live?.progress_pct || 0),
      // The programme was re-planned by this much, whether or not it slipped.
      plan_slip_days: baselineEnd && currentEnd ? daysBetween(baselineEnd, currentEnd) : null,
      // Delivered this many days after it was meant to be.
      actual_slip_days: baselineEnd && actualEnd ? daysBetween(baselineEnd, actualEnd) : null,
      // Still open and already past its baseline date.
      days_late: !complete && baselineEnd && asOf.getTime() > baselineEnd.getTime()
        ? daysBetween(baselineEnd, asOf) : 0,
    };
  });

  // Stages added after the baseline was frozen aren't slip, but they are scope
  // that nothing was ever promised about — which is worth seeing next to it.
  const added = milestones
    .filter((m) => !baselineIds.has(String(m._id)))
    .map((m) => ({
      milestone_id: String(m._id),
      name: m.name,
      added_since_baseline: true,
      weight: m.weight ?? 1,
      baseline_start: null,
      baseline_end: null,
      current_end: m.planned_end || null,
      actual_end: m.actual_end || null,
      status: m.status,
      progress_pct: round2(m.progress_pct || 0),
      plan_slip_days: null,
      actual_slip_days: null,
      days_late: 0,
    }));

  const baselineEnd = toDate(baseline.planned_end_date);
  const currentEnd = toDate(project.planned_end_date);
  const baselineStart = toDate(baseline.start_date);

  // Where the finish lands if the job keeps performing exactly as it has.
  // Indicative only, and meaningless before enough of the work has happened to
  // read a rate from, so it is withheld below 5%.
  let forecastEnd = null;
  if (spi && spi > 0 && baselineStart && baselineEnd && actualPct >= 5 && actualPct < 100) {
    const plannedDuration = daysBetween(baselineStart, baselineEnd);
    if (plannedDuration > 0) forecastEnd = addDays(baselineStart, Math.round(plannedDuration / spi));
  }

  return {
    has_baseline: true,
    currency: project.currency || 'GHS',
    baseline: {
      id: String(baseline._id),
      version: baseline.version,
      name: baseline.name,
      reason: baseline.reason || null,
      set_on: baseline.createdAt,
      start_date: baseline.start_date,
      planned_end_date: baseline.planned_end_date,
      contract_value: bac,
      milestone_count: (baseline.milestones || []).length,
    },
    as_of: asOf,
    planned_pct: plannedPct,
    actual_pct: actualPct,
    planned_value: plannedValue,
    earned_value: earnedValue,
    // Positive means more has been earned than was planned by now.
    schedule_variance: round2(earnedValue - plannedValue),
    spi,
    status: spi === null ? 'unknown'
      : spi >= 1.02 ? 'ahead'
      : spi >= 0.95 ? 'on_track'
      : 'behind',
    baseline_end_date: baseline.planned_end_date || null,
    current_end_date: project.planned_end_date || null,
    // How far the agreed finish date has been moved since the baseline.
    completion_slip_days: baselineEnd && currentEnd ? daysBetween(baselineEnd, currentEnd) : null,
    forecast_end_date: forecastEnd,
    // Slip against the baseline finish implied by the current rate of work.
    forecast_slip_days: forecastEnd && baselineEnd ? daysBetween(baselineEnd, forecastEnd) : null,
    milestones: [...rows, ...added],
    curve: buildCurve(baseline, milestones, project, asOf),
  };
}

/**
 * Planned and actual progress by month — the S-curve.
 *
 * The actual side is built from milestone completion dates, since no history of
 * the progress figure is kept. That makes it a step curve rather than a smooth
 * one, and it understates months where a stage was part-finished. The final
 * point uses the live weighted figure instead, which does count part-finished
 * work, so the end of the line is the accurate one.
 */
function buildCurve(baseline, milestones, project, asOf) {
  const start = toDate(baseline.start_date) || toDate(baseline.createdAt) || asOf;
  const ends = [toDate(baseline.planned_end_date), toDate(project.planned_end_date), asOf].filter(Boolean);
  const finish = new Date(Math.max(...ends.map((d) => d.getTime())));

  const points = [];
  let cursor = startOfMonth(start);
  const nowMonth = monthKey(asOf);

  // 60 months is far past the point where a monthly curve tells anyone
  // anything, and guards against a mistyped date generating forever.
  for (let i = 0; i < 60; i += 1) {
    const bucketEnd = endOfMonth(cursor);
    const key = monthKey(cursor);
    const isCurrentMonth = key === nowMonth;

    points.push({
      month: key,
      label: monthLabel(cursor),
      planned_pct: plannedPctAt(baseline.milestones || [], bucketEnd),
      // Nothing is claimed about the future. The month in progress uses the
      // live weighted figure, which counts part-finished stages; earlier months
      // can only be rebuilt from what was actually signed off.
      actual_pct: isCurrentMonth ? round2(project.progress_pct || 0)
        : bucketEnd.getTime() < asOf.getTime() ? actualPctAt(milestones, bucketEnd)
        : null,
    });

    if (cursor.getTime() > finish.getTime()) break;
    cursor = addMonths(cursor, 1);
  }

  return points;
}

/* ── Cash flow forecast ───────────────────────────────────────────────────── */

/**
 * Decide what the job is now expected to cost in total.
 *
 * A budget is the best answer where one was set, but it cannot be believed
 * below what has already been spent and committed. Failing that, the rate at
 * which money has gone out per point of progress is extrapolated — which is
 * only meaningful once enough work has happened to read a rate from, hence the
 * floor. Below that, all that can honestly be said is what is already known.
 */
function forecastTotalCost({ budget, actualCost, committed, progressPct }) {
  if (budget > 0) return { total: round2(Math.max(budget, actualCost + committed)), basis: 'budget' };
  if (progressPct >= 10) return { total: round2(actualCost / (progressPct / 100)), basis: 'run_rate' };
  return { total: round2(actualCost + committed), basis: 'committed' };
}

/**
 * Money in and money out, by month.
 *
 * Timing is the whole point. Inflows sit at the date the client is expected to
 * pay — certification plus the contract's payment terms — not the date the work
 * is done. Outflows sit where the spending falls. The deepest point of the
 * cumulative line is the working capital the job needs, and it is routinely the
 * number that decides whether a profitable contract can actually be taken on.
 */
async function getCashFlowForecast(projectId, tenantId, { months = 12, asOf = new Date() } = {}) {
  const project = await Project.findOne({ _id: projectId, tenant_id: tenantId }).lean();
  if (!project) return null;

  const [financials, position, milestones, invoices, orders] = await Promise.all([
    projectService.getFinancials(projectId, tenantId),
    projectService.getBillingPosition(projectId, tenantId),
    ProjectMilestone.find({ project_id: projectId, tenant_id: tenantId }).sort({ sequence: 1, createdAt: 1 }).lean(),
    Invoice.find({ project_id: projectId, tenant_id: tenantId, status: { $nin: ['void', 'paid'] } })
      .select('invoice_number due_date total amount_paid status is_retention_release').lean(),
    PurchaseOrder.find({
      project_id: projectId,
      tenant_id: tenantId,
      status: { $nin: ['cancelled', 'draft'] },
      payment_status: { $ne: 'paid' },
    }).select('po_number total_cost payments expected_date status').lean(),
  ]);

  const retentionPct = project.retention_pct || 0;
  const termsDays = project.payment_terms_days ?? 30;
  const defectsDays = project.defects_liability_days ?? 0;
  const events = [];
  const warnings = [];

  /* Money in ─────────────────────────────────────────────────────────────── */

  // 1. Applications already raised and not yet settled. An overdue one is still
  //    expected, so it lands now rather than in the past where it would be
  //    invisible on a forward-looking curve.
  let overdueReceivables = 0;
  for (const inv of invoices) {
    const outstanding = round2((inv.total || 0) - (inv.amount_paid || 0));
    if (outstanding <= 0) continue;
    const due = toDate(inv.due_date);
    const late = !due || due.getTime() < asOf.getTime();
    if (late) overdueReceivables = round2(overdueReceivables + outstanding);
    events.push({
      date: late ? asOf : due,
      direction: 'in',
      category: inv.is_retention_release ? 'retention_release' : 'receivable',
      label: `${inv.invoice_number}${late ? ' (overdue)' : ''}`,
      amount: outstanding,
    });
  }

  // 2. Work still to be certified. Milestone billing values are used where the
  //    project carries them; otherwise what is left to certify is apportioned
  //    across the unfinished stages by weight, so a project that bills on
  //    valuation rather than by stage still gets a curve.
  const unbilled = milestones.filter((m) => !m.billed_invoice_id);
  const milestoneBillable = round2(unbilled.reduce((s, m) => s + (m.billable_amount || 0), 0));
  const remainingToCertify = position?.remaining_to_certify || 0;

  const certifications = [];
  if (milestoneBillable > 0) {
    // Never forecast billing past the contract, variations included.
    const scale = milestoneBillable > remainingToCertify && remainingToCertify > 0
      ? remainingToCertify / milestoneBillable : 1;
    for (const m of unbilled) {
      const gross = round2((m.billable_amount || 0) * scale);
      if (gross <= 0) continue;
      certifications.push({ gross, when: toDate(m.planned_end), name: m.name });
    }
  } else if (remainingToCertify > 0) {
    const open = milestones.filter((m) => m.status !== 'completed');
    const spread = open.length ? open : milestones;
    const totalWeight = spread.reduce((s, m) => s + (m.weight ?? 1), 0);
    if (totalWeight > 0) {
      for (const m of spread) {
        const gross = round2(remainingToCertify * ((m.weight ?? 1) / totalWeight));
        if (gross <= 0) continue;
        certifications.push({ gross, when: toDate(m.planned_end), name: m.name });
      }
    } else {
      certifications.push({ gross: remainingToCertify, when: toDate(project.planned_end_date), name: 'Remaining work' });
    }
  }

  let futureRetention = 0;
  let undatedCertification = 0;
  for (const c of certifications) {
    const retained = round2(c.gross * (retentionPct / 100));
    futureRetention = round2(futureRetention + retained);
    // Work already overdue for certification is treated as certified now
    // rather than in the past.
    const certifyOn = c.when && c.when.getTime() > asOf.getTime() ? c.when : asOf;
    if (!c.when) undatedCertification = round2(undatedCertification + c.gross);
    events.push({
      date: addDays(certifyOn, termsDays),
      direction: 'in',
      category: 'certification',
      label: c.name,
      amount: round2(c.gross - retained),
    });
  }

  // 3. Retention, released once the defects period is served. Covers what the
  //    client already holds plus what the applications above will add.
  const retentionDue = round2((position?.retention_outstanding || 0) + futureRetention);
  if (retentionDue > 0) {
    const completion = toDate(project.actual_end_date) || toDate(project.planned_end_date);
    if (completion) {
      events.push({
        date: addDays(completion, defectsDays),
        direction: 'in',
        category: 'retention_release',
        label: 'Retention released',
        amount: retentionDue,
      });
    } else {
      warnings.push(`${round2(retentionDue)} of retention isn't on the curve — the project has no completion date to release it against.`);
    }
  }

  /* Money out ────────────────────────────────────────────────────────────── */

  // 1. Orders raised and not yet paid, at the date they are expected to land.
  let poOutstanding = 0;
  for (const po of orders) {
    const paid = (po.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
    const outstanding = round2((po.total_cost || 0) - paid);
    if (outstanding <= 0) continue;
    poOutstanding = round2(poOutstanding + outstanding);
    const expected = toDate(po.expected_date);
    events.push({
      date: expected && expected.getTime() > asOf.getTime() ? expected : asOf,
      direction: 'out',
      category: 'purchase_order',
      label: po.po_number || 'Purchase order',
      amount: outstanding,
    });
  }

  // 2. Everything else it will take to finish, spread across the stages left to
  //    do. What is already on an order is excluded — that was counted above.
  const { total: forecastCost, basis } = forecastTotalCost({
    budget: financials?.budget || 0,
    actualCost: financials?.actual_cost || 0,
    committed: poOutstanding,
    progressPct: financials?.progress_pct || 0,
  });
  const costToComplete = round2(Math.max(0, forecastCost - (financials?.actual_cost || 0) - poOutstanding));

  if (costToComplete > 0) {
    const open = milestones.filter((m) => m.status !== 'completed');
    const spread = open.length ? open : milestones;
    const totalWeight = spread.reduce((s, m) => s + (m.weight ?? 1), 0);
    if (totalWeight > 0) {
      for (const m of spread) {
        const share = round2(costToComplete * ((m.weight ?? 1) / totalWeight));
        if (share <= 0) continue;
        const when = toDate(m.planned_end);
        events.push({
          date: when && when.getTime() > asOf.getTime() ? when : asOf,
          direction: 'out',
          category: 'cost_to_complete',
          label: m.name,
          amount: share,
        });
      }
    } else {
      const when = toDate(project.planned_end_date);
      events.push({
        date: when && when.getTime() > asOf.getTime() ? when : asOf,
        direction: 'out',
        category: 'cost_to_complete',
        label: 'Cost to complete',
        amount: costToComplete,
      });
    }
  }

  /* Bucketing ────────────────────────────────────────────────────────────── */

  // The horizon stretches to cover the last event — usually the retention
  // release, which can sit a year past completion and is exactly the thing a
  // fixed twelve-month window would hide.
  const first = startOfMonth(asOf);
  const lastEvent = events.length
    ? new Date(Math.max(...events.map((e) => new Date(e.date).getTime())))
    : first;
  const spanMonths = Math.max(
    months,
    (lastEvent.getUTCFullYear() - first.getUTCFullYear()) * 12 + (lastEvent.getUTCMonth() - first.getUTCMonth()) + 1,
  );
  const horizon = Math.min(spanMonths, 36);

  const buckets = [];
  for (let i = 0; i < horizon; i += 1) {
    const m = addMonths(first, i);
    buckets.push({
      month: monthKey(m),
      label: monthLabel(m),
      inflow: 0,
      outflow: 0,
      net: 0,
      cumulative: 0,
      by_category: {},
    });
  }
  const indexOf = new Map(buckets.map((b, i) => [b.month, i]));

  for (const e of events) {
    // Anything past the horizon is folded into the final bucket rather than
    // dropped, so the totals still add up to the whole job.
    const idx = indexOf.has(monthKey(e.date)) ? indexOf.get(monthKey(e.date))
      : new Date(e.date).getTime() < first.getTime() ? 0
      : buckets.length - 1;
    const b = buckets[idx];
    if (e.direction === 'in') b.inflow = round2(b.inflow + e.amount);
    else b.outflow = round2(b.outflow + e.amount);
    b.by_category[e.category] = round2((b.by_category[e.category] || 0) + e.amount);
  }

  let running = 0;
  let low = { month: buckets[0]?.month || null, label: buckets[0]?.label || null, cumulative: 0 };
  for (const b of buckets) {
    b.net = round2(b.inflow - b.outflow);
    running = round2(running + b.net);
    b.cumulative = running;
    if (running < low.cumulative) low = { month: b.month, label: b.label, cumulative: running };
  }

  const totalIn = round2(buckets.reduce((s, b) => s + b.inflow, 0));
  const totalOut = round2(buckets.reduce((s, b) => s + b.outflow, 0));
  const peakFunding = round2(Math.max(0, -low.cumulative));

  /* What the reader should be told not to trust ──────────────────────────── */

  if (peakFunding > 0) {
    warnings.push(`This job needs about ${round2(peakFunding)} of working capital, at its worst around ${low.label}.`);
  }
  if (overdueReceivables > 0) {
    warnings.push(`${overdueReceivables} is already past its due date and is shown as due now.`);
  }
  if (undatedCertification > 0) {
    warnings.push(`${undatedCertification} of work has no milestone date, so it is timed from today. Dating the stages will sharpen this.`);
  }
  if (basis === 'run_rate') {
    warnings.push('No budget is set, so the remaining cost is extrapolated from what has been spent per point of progress.');
  }
  if (basis === 'committed') {
    warnings.push('Too little of the job has run to forecast a cost. Outflows show only what is already spent or ordered.');
  }
  if (!termsDays) {
    warnings.push('Payment terms are set to zero days, so the client is assumed to pay on certification.');
  }

  return {
    currency: project.currency || 'GHS',
    as_of: asOf,
    assumptions: {
      payment_terms_days: termsDays,
      defects_liability_days: defectsDays,
      retention_pct: retentionPct,
      cost_basis: basis,
      forecast_cost: forecastCost,
      cost_to_complete: costToComplete,
    },
    buckets,
    totals: {
      inflow: totalIn,
      outflow: totalOut,
      net: round2(totalIn - totalOut),
      receivables_outstanding: round2(invoices.reduce((s, i) => s + ((i.total || 0) - (i.amount_paid || 0)), 0)),
      overdue_receivables: overdueReceivables,
      po_outstanding: poOutstanding,
      retention_due: retentionDue,
    },
    // The deepest the cumulative line goes, and so the money the job has to be
    // funded with before it starts paying for itself.
    low_point: low,
    peak_funding_required: peakFunding,
    warnings,
  };
}

module.exports = {
  setBaseline,
  getScheduleVariance,
  getCashFlowForecast,
  // Exported for tests.
  plannedFractionAt,
  plannedPctAt,
  forecastTotalCost,
  startOfMonth,
  addMonths,
  endOfMonth,
  monthKey,
};
