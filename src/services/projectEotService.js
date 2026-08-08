const { Project, ProjectDiary, ProjectEotClaim } = require('../models');
const projectService = require('./projectService');

/**
 * Projects — extensions of time.
 *
 * Running late is not a claim. Whether lost time earns anything turns on whose
 * risk the cause was, and contracts draw the line in three places rather than
 * two:
 *
 *   time and cost  — the client's risk. A late instruction or a site that
 *                    couldn't be got into earns both an extension and the cost
 *                    of standing around waiting.
 *   time only      — a neutral event. Nobody's fault, so the contractor gets
 *                    relief from damages but carries its own costs. Weather is
 *                    the usual example.
 *   no entitlement — the contractor's own risk. Its labour not turning up, its
 *                    plant breaking, its materials ordered late.
 *
 * Which is why a claim argued from "it rained a lot in March" goes nowhere and
 * one argued from dated entries with hours attributed to a cause is answerable.
 * The diary already captures the second kind. This turns it into the claim.
 */

const { round2 } = projectService;

/**
 * How each recorded cause is treated by default.
 *
 * Defaults, not rulings — entitlement is a matter of the contract signed, and a
 * clause can move any of these. Materials are the clearest example: normally
 * the contractor's own procurement problem, but client-supplied materials are
 * the client's risk entirely. So the figures below are shown as a starting
 * point and the days actually claimed stay a human decision.
 */
const CAUSE_ENTITLEMENT = {
  weather:            'time_only',
  client_instruction: 'time_and_cost',
  access:             'time_and_cost',
  materials:          'no_entitlement',
  labour:             'no_entitlement',
  plant:              'no_entitlement',
  other:              'unclassified',
};

const ENTITLEMENT_LABEL = {
  time_and_cost:  'Time and cost',
  time_only:      'Time only',
  no_entitlement: 'No entitlement',
  unclassified:   'Needs a decision',
};

/** Claims that still hold their evidence. A withdrawn or rejected one frees it. */
const LIVE_CLAIM_STATUSES = ['draft', 'submitted', 'granted', 'partially_granted'];

/**
 * Read a window of the diary and work out what is claimable in it.
 *
 * Entries already cited on a live claim are separated out rather than counted
 * again — the same lost afternoon argued twice is the fastest way to have a
 * whole claim disbelieved.
 */
async function analysePeriod(projectId, tenantId, { from, to, excludeClaimId } = {}) {
  const project = await Project.findOne({ _id: projectId, tenant_id: tenantId }).lean();
  if (!project) return null;

  const hoursPerDay = project.working_hours_per_day > 0 ? project.working_hours_per_day : 8;

  const filter = { project_id: projectId, tenant_id: tenantId };
  if (from || to) {
    filter.entry_date = {};
    if (from) filter.entry_date.$gte = new Date(from);
    if (to) filter.entry_date.$lte = new Date(to);
  }

  const [entries, liveClaims] = await Promise.all([
    ProjectDiary.find(filter).sort({ entry_date: 1 }).lean(),
    ProjectEotClaim.find({
      project_id: projectId,
      tenant_id: tenantId,
      status: { $in: LIVE_CLAIM_STATUSES },
      ...(excludeClaimId ? { _id: { $ne: excludeClaimId } } : {}),
    }).select('reference diary_entry_ids').lean(),
  ]);

  const cited = new Map();
  for (const c of liveClaims) {
    for (const eid of c.diary_entry_ids || []) cited.set(String(eid), c.reference);
  }

  const byCause = new Map();
  const evidence = [];
  let alreadyClaimedHours = 0;

  for (const e of entries) {
    const claimedOn = cited.get(String(e._id)) || null;
    const entryHours = round2((e.delays || []).reduce((s, d) => s + (d.hours_lost || 0), 0));
    if (!entryHours) continue;

    evidence.push({
      id: String(e._id),
      entry_date: e.entry_date,
      weather: e.weather,
      worked: e.worked,
      hours_lost: entryHours,
      causes: (e.delays || []).map((d) => d.cause),
      already_claimed_on: claimedOn,
    });

    if (claimedOn) {
      alreadyClaimedHours = round2(alreadyClaimedHours + entryHours);
      continue;
    }

    for (const d of e.delays || []) {
      const cause = d.cause || 'other';
      const row = byCause.get(cause) || { cause, hours_lost: 0, occurrences: 0 };
      row.hours_lost = round2(row.hours_lost + (d.hours_lost || 0));
      row.occurrences += 1;
      byCause.set(cause, row);
    }
  }

  const causes = [...byCause.values()]
    .map((r) => ({
      ...r,
      days_equivalent: round2(r.hours_lost / hoursPerDay),
      entitlement: CAUSE_ENTITLEMENT[r.cause] || 'unclassified',
      entitlement_label: ENTITLEMENT_LABEL[CAUSE_ENTITLEMENT[r.cause] || 'unclassified'],
    }))
    .sort((a, b) => b.hours_lost - a.hours_lost);

  const sumWhere = (test) => round2(causes.filter(test).reduce((s, c) => s + c.hours_lost, 0));
  const earnsTime = (c) => c.entitlement === 'time_and_cost' || c.entitlement === 'time_only';

  const totalHours = round2(causes.reduce((s, c) => s + c.hours_lost, 0));
  const claimableHours = sumWhere(earnsTime);
  const compensableHours = sumWhere((c) => c.entitlement === 'time_and_cost');
  const unclassifiedHours = sumWhere((c) => c.entitlement === 'unclassified');

  return {
    period_from: from ? new Date(from) : (entries[0]?.entry_date || null),
    period_to: to ? new Date(to) : (entries[entries.length - 1]?.entry_date || null),
    working_hours_per_day: hoursPerDay,
    entries_examined: entries.length,
    entries_with_delays: evidence.length,

    causes,
    hours_lost_total: totalHours,
    // Lost time that earns an extension, whether or not it also earns money.
    claimable_hours: claimableHours,
    claimable_days: round2(claimableHours / hoursPerDay),
    // The subset that also earns prolongation cost.
    compensable_hours: compensableHours,
    compensable_days: round2(compensableHours / hoursPerDay),
    // Recorded as "other", so nobody has yet said whose risk it was.
    unclassified_hours: unclassifiedHours,
    unclassified_days: round2(unclassifiedHours / hoursPerDay),
    // The contractor's own risk. Shown because it is worth knowing how much of
    // a delay cannot be passed on.
    own_risk_hours: sumWhere((c) => c.entitlement === 'no_entitlement'),

    already_claimed_hours: alreadyClaimedHours,
    evidence,
    // Entries free to cite on a new claim.
    claimable_entry_ids: evidence.filter((e) => !e.already_claimed_on).map((e) => e.id),
  };
}

/** Next claim reference for a project, e.g. EOT-003. */
async function nextReference(projectId, tenantId) {
  const count = await ProjectEotClaim.countDocuments({ project_id: projectId, tenant_id: tenantId });
  return `EOT-${String(count + 1).padStart(3, '0')}`;
}

/**
 * Where the project stands on time claimed overall.
 *
 * The gap between claimed and granted is the number worth watching: a job
 * carrying months of submitted-but-undecided claims is exposed to damages it
 * may never actually owe, and nobody notices until the client asks for them.
 */
async function getClaimPosition(projectId, tenantId) {
  const claims = await ProjectEotClaim.find({ project_id: projectId, tenant_id: tenantId })
    .select('status days_claimed days_granted cost_claimed cost_granted')
    .lean();

  const sum = (test, field) => round2(claims.filter(test).reduce((s, c) => s + (c[field] || 0), 0));
  const decided = (c) => ['granted', 'partially_granted'].includes(c.status);

  return {
    claims: claims.length,
    submitted: claims.filter((c) => c.status === 'submitted').length,
    days_claimed: sum((c) => c.status !== 'withdrawn' && c.status !== 'rejected', 'days_claimed'),
    days_granted: sum(decided, 'days_granted'),
    // Claimed, not refused, and still waiting on the client.
    days_awaiting: sum((c) => c.status === 'submitted', 'days_claimed'),
    days_rejected: sum((c) => c.status === 'rejected', 'days_claimed'),
    cost_claimed: sum((c) => c.status !== 'withdrawn' && c.status !== 'rejected', 'cost_claimed'),
    cost_granted: sum(decided, 'cost_granted'),
  };
}

module.exports = {
  CAUSE_ENTITLEMENT,
  ENTITLEMENT_LABEL,
  LIVE_CLAIM_STATUSES,
  analysePeriod,
  nextReference,
  getClaimPosition,
};
