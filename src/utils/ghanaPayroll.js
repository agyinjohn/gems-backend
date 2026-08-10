/**
 * Ghana payroll statutory calculations.
 *
 * The figures themselves are not here — they live in config/payrollRates.js,
 * dated, so a budget that changes them does not need a release. This file only
 * knows how to apply whatever it is handed.
 */

const { payeBandsFor, pensionRatesFor } = require('../config/payrollRates');

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Progressive PAYE: income is sliced across the bands, each slice taxed at its
 * own rate. A band with no ceiling takes everything above the one below it.
 */
function calculatePaye(taxableMonthly, bands) {
  const income = Math.max(0, Number(taxableMonthly) || 0);
  const table = Array.isArray(bands) && bands.length ? bands : payeBandsFor(new Date());
  let tax = 0;
  let previous = 0;
  for (const band of table) {
    const ceiling = band.up_to === null || band.up_to === undefined || band.up_to === ''
      ? Infinity
      : Number(band.up_to);
    const slice = Math.min(income, ceiling) - previous;
    if (slice <= 0) break;
    tax += slice * (Number(band.rate) || 0);
    previous = ceiling;
    if (income <= ceiling) break;
  }
  return round2(tax);
}

/**
 * Two bases, not one.
 *
 * Tax and pension are charged on different money. PAYE is on everything the
 * employee receives — basic pay and all allowances. Pension is on basic salary
 * only, plus whatever allowances the employer has agreed to treat as
 * pensionable, which is usually none.
 *
 * Running both off gross-plus-allowances, as this used to, overstates the
 * employee's deduction, the employer's liability, and both remittances, on
 * every payslip that carries an allowance. It also understates PAYE slightly,
 * since the inflated pension contribution takes a larger relief with it.
 *
 * @param {number} basicSalary - contractual pay for the period, prorated.
 * @param {number} [allowances=0] - everything on top of it.
 * @param {object} [options]
 * @param {number} [options.pensionableAllowances=0] - the part of `allowances`
 *   that the employer treats as attracting pension. Never more than the total.
 * @param {boolean} [options.applySsnit=true] - false for tenants that don't run
 *   formal SSNIT (e.g. informal/non-registered employers).
 * @param {boolean} [options.applyPaye=true] - false for tenants that don't
 *   withhold income tax.
 * @param {Array}  [options.payeBands] - bands in force for the period.
 * @param {object} [options.pensionRates] - employee/employer and tier rates.
 * @param {boolean} [options.tier3Enabled=false] - the voluntary provident fund.
 * @param {number} [options.tier3EmployeeRate=0] - deducted from the employee.
 * @param {number} [options.tier3EmployerRate=0] - added by the business.
 */
function calculateStatutory(basicSalary, allowances = 0, options = {}) {
  const {
    applySsnit = true, applyPaye = true, payeBands, pensionRates,
    pensionableAllowances = 0,
    tier3Enabled = false, tier3EmployeeRate = 0, tier3EmployerRate = 0,
  } = options;
  const rates = pensionRates || pensionRatesFor(new Date());

  const basic = round2(parseFloat(basicSalary) || 0);
  const allowanceTotal = round2(parseFloat(allowances) || 0);
  // Guarded rather than trusted: a pensionable figure above the total would
  // silently inflate every contribution, which is the bug this replaces.
  const pensionable = Math.min(
    Math.max(round2(parseFloat(pensionableAllowances) || 0), 0),
    allowanceTotal,
  );

  const taxableGross = round2(basic + allowanceTotal);
  const pensionBase = round2(basic + pensionable);

  const ssnitEmployee = applySsnit ? round2(pensionBase * rates.employee_rate) : 0;
  const ssnitEmployer = applySsnit ? round2(pensionBase * rates.employer_rate) : 0;

  // The same money, seen from the other end: what leaves the business, split
  // between the two institutions it has to reach. Rounded from the base rather
  // than derived from the employee/employer figures, so neither view inherits
  // the other's rounding.
  const tier1 = applySsnit ? round2(pensionBase * rates.tier1_rate) : 0;
  const tier2 = applySsnit ? round2(pensionBase * rates.tier2_rate) : 0;

  // Tier 3 is voluntary and independent of the mandatory scheme — a business
  // can run one without the other, so it is not gated on applySsnit. Charged on
  // the same base, because it is a pension contribution like the others.
  const rate3Employee = Math.max(Number(tier3EmployeeRate) || 0, 0);
  const rate3Employer = Math.max(Number(tier3EmployerRate) || 0, 0);
  const tier3Employee = tier3Enabled ? round2(pensionBase * rate3Employee) : 0;
  const tier3Employer = tier3Enabled ? round2(pensionBase * rate3Employer) : 0;

  // Pension contributions reduce taxable income, but only so far. The ceiling
  // counts the employee's Tier 1 contribution towards it, so a business running
  // Tier 3 at a high rate does not get unlimited relief — anything above the cap
  // is still deducted from pay, it just isn't tax-free.
  const reliefCap = round2(pensionBase * (rates.tier3_relief_cap_rate ?? 0.165));
  const reliefClaimed = Math.min(round2(ssnitEmployee + tier3Employee), reliefCap);

  const taxableIncome = Math.max(0, round2(taxableGross - reliefClaimed));
  const paye = applyPaye ? calculatePaye(taxableIncome, payeBands) : 0;
  const totalDeductions = round2(ssnitEmployee + tier3Employee + paye);
  const net = round2(taxableGross - totalDeductions);

  return {
    gross_salary: basic,
    allowances: allowanceTotal,
    taxable_gross: taxableGross,
    // What pension was actually charged on — kept so a payslip can show it and
    // an auditor does not have to reconstruct it from the rate.
    pensionable_base: applySsnit ? pensionBase : 0,
    ssnit_employee: ssnitEmployee,
    ssnit_employer: ssnitEmployer,
    ssnit_tier1: tier1,
    ssnit_tier2: tier2,
    tier3_employee: tier3Employee,
    tier3_employer: tier3Employer,
    // What actually came off taxable pay, which is not the same as what was
    // contributed once the ceiling bites.
    pension_relief: applyPaye ? reliefClaimed : 0,
    pension_relief_cap: reliefCap,
    paye,
    statutory_deductions: totalDeductions,
    net_salary: net,
    deductions: totalDeductions,
    // What the employee's lines should say, given the rates actually applied.
    employee_rate: rates.employee_rate,
    tier3_employee_rate: tier3Enabled ? rate3Employee : 0,
  };
}

module.exports = {
  calculatePaye,
  calculateStatutory,
};
