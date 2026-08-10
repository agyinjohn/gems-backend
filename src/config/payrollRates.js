/**
 * Ghana's statutory payroll rates, as data with dates on them.
 *
 * These were constants compiled into the calculation. That is fine right up
 * until the figures change, which they do in most budgets — and then every
 * payslip produced is quietly wrong until somebody ships a release. A payroll
 * system whose tax table can only be corrected by a deploy is a payroll system
 * that is wrong for however long the deploy takes.
 *
 * Two things follow from that:
 *
 *   Rates are dated. A schedule is a list of "from this date, these figures",
 *   and payroll for a period picks whichever entry was in force *then*. Running
 *   October's payroll in December uses October's bands, which is the only
 *   answer that survives an audit.
 *
 *   A tenant can override. The built-in schedule below is the national one and
 *   is what everybody gets; a business that needs different figures before the
 *   next release does not have to wait for one.
 *
 * When Ghana revises anything, append a new dated entry here. Do not edit an
 * existing one: that would silently restate payslips already issued under it.
 */

/**
 * PAYE.
 *
 * Monthly bands, each `up_to` being the top of that slice of income, and the
 * last one open-ended. Progressive: income is sliced across the bands, not
 * taxed wholly at the rate its total happens to reach.
 */
const PAYE_SCHEDULE = [
  {
    effective_from: '2024-01-01',
    label: 'Ghana 2024 monthly bands',
    bands: [
      { up_to: 490, rate: 0 },
      { up_to: 600, rate: 0.05 },
      { up_to: 730, rate: 0.1 },
      { up_to: 3896.67, rate: 0.175 },
      { up_to: 19896.67, rate: 0.25 },
      { up_to: null, rate: 0.3 },
    ],
  },
];

/**
 * Pension.
 *
 * The 18.5% goes in and comes out again split two ways, and the two halves are
 * paid to two different institutions:
 *
 *   in   employee 5.5% + employer 13%   = 18.5% of the contributory base
 *   out  Tier 1 13.5% → SSNIT
 *        Tier 2  5%   → the employer's private trustee
 *
 * Contributed and remitted are different views of the same money, which is why
 * both are kept. A payslip shows what the employee lost; the two remittances
 * are what the business actually has to pay, to two separate places, and no
 * arrangement of the employee/employer split answers that question.
 */
const PENSION_SCHEDULE = [
  {
    effective_from: '2024-01-01',
    label: 'SSNIT Tier 1 + Tier 2',
    employee_rate: 0.055,
    employer_rate: 0.13,
    tier1_rate: 0.135,
    tier2_rate: 0.05,
  },
];

/** A schedule entry is in force from its date until the next one starts. */
function inForceAt(schedule, when) {
  const at = when instanceof Date ? when : new Date(when || Date.now());
  const stamp = Number.isNaN(at.getTime()) ? Date.now() : at.getTime();
  const applicable = schedule
    .filter((entry) => new Date(entry.effective_from).getTime() <= stamp)
    .sort((a, b) => new Date(b.effective_from) - new Date(a.effective_from));
  // Nothing dated early enough means payroll for a period before the oldest
  // entry. The oldest is still the best answer available, and refusing to
  // calculate would be worse than calculating on the earliest known figures.
  return applicable[0] || schedule[schedule.length - 1];
}

/** The first day of a payroll month — what "in force then" is measured against. */
const periodStart = (month, year) => new Date(Date.UTC(year, (month || 1) - 1, 1));

/**
 * Bands in force for a period, preferring the tenant's own schedule.
 *
 * An override with no entry old enough to cover the period falls back to the
 * national schedule rather than to the tenant's earliest, because a tenant who
 * set their own rates last year did not thereby make a claim about the year
 * before that.
 */
function payeBandsFor(when, override) {
  const own = Array.isArray(override) ? override.filter((e) => e && Array.isArray(e.bands) && e.bands.length) : [];
  const at = when instanceof Date ? when : new Date(when || Date.now());
  const covered = own.some((e) => new Date(e.effective_from).getTime() <= at.getTime());
  return inForceAt(covered ? own : PAYE_SCHEDULE, at).bands;
}

function pensionRatesFor(when, override) {
  const own = Array.isArray(override) ? override.filter((e) => e && e.effective_from) : [];
  const at = when instanceof Date ? when : new Date(when || Date.now());
  const covered = own.some((e) => new Date(e.effective_from).getTime() <= at.getTime());
  const entry = inForceAt(covered ? own : PENSION_SCHEDULE, at);
  const fallback = PENSION_SCHEDULE[PENSION_SCHEDULE.length - 1];
  return {
    employee_rate: numberOr(entry.employee_rate, fallback.employee_rate),
    employer_rate: numberOr(entry.employer_rate, fallback.employer_rate),
    tier1_rate: numberOr(entry.tier1_rate, fallback.tier1_rate),
    tier2_rate: numberOr(entry.tier2_rate, fallback.tier2_rate),
  };
}

const numberOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * Do the two halves agree?
 *
 * What goes in must come out. If they drift apart the payslips and the
 * remittances stop describing the same money, and nothing downstream would
 * notice — so it is checked where the rates are set rather than left to be
 * discovered in a reconciliation months later.
 */
function pensionRatesBalance(rates) {
  const contributed = (Number(rates.employee_rate) || 0) + (Number(rates.employer_rate) || 0);
  const remitted = (Number(rates.tier1_rate) || 0) + (Number(rates.tier2_rate) || 0);
  return Math.abs(contributed - remitted) < 0.000001;
}

/** Bands are usable only if they climb, and only if the last one is open-ended. */
function validatePayeBands(bands) {
  if (!Array.isArray(bands) || !bands.length) return 'Give at least one tax band.';
  let previous = 0;
  for (let i = 0; i < bands.length; i += 1) {
    const band = bands[i] || {};
    const rate = Number(band.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      return 'Each band needs a rate between 0 and 1 — 0.175 for 17.5%.';
    }
    const last = i === bands.length - 1;
    if (last) {
      if (band.up_to !== null && band.up_to !== undefined && band.up_to !== '') {
        return 'The top band must be open-ended — leave its ceiling empty.';
      }
      continue;
    }
    const upTo = Number(band.up_to);
    if (!Number.isFinite(upTo) || upTo <= previous) {
      return 'Each band must end above the one before it.';
    }
    previous = upTo;
  }
  return null;
}

module.exports = {
  PAYE_SCHEDULE,
  PENSION_SCHEDULE,
  payeBandsFor,
  pensionRatesFor,
  pensionRatesBalance,
  validatePayeBands,
  periodStart,
  inForceAt,
};
