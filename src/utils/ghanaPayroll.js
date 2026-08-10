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
 * @param {number} grossSalary
 * @param {number} [extraAllowances=0]
 * @param {object} [options]
 * @param {boolean} [options.applySsnit=true] - false for tenants that don't run
 *   formal SSNIT (e.g. informal/non-registered employers).
 * @param {boolean} [options.applyPaye=true] - false for tenants that don't
 *   withhold income tax.
 * @param {Array}  [options.payeBands] - bands in force for the period.
 * @param {object} [options.pensionRates] - employee/employer and tier rates.
 */
function calculateStatutory(grossSalary, extraAllowances = 0, options = {}) {
  const { applySsnit = true, applyPaye = true, payeBands, pensionRates } = options;
  const rates = pensionRates || pensionRatesFor(new Date());

  const gross = round2(parseFloat(grossSalary) || 0);
  const allowances = round2(parseFloat(extraAllowances) || 0);
  const taxableGross = gross + allowances;

  const ssnitEmployee = applySsnit ? round2(taxableGross * rates.employee_rate) : 0;
  const ssnitEmployer = applySsnit ? round2(taxableGross * rates.employer_rate) : 0;

  // The same money, seen from the other end: what leaves the business, split
  // between the two institutions it has to reach. Rounded from the base rather
  // than derived from the employee/employer figures, so neither view inherits
  // the other's rounding.
  const tier1 = applySsnit ? round2(taxableGross * rates.tier1_rate) : 0;
  const tier2 = applySsnit ? round2(taxableGross * rates.tier2_rate) : 0;

  // PAYE relief for the SSNIT employee contribution only applies if it was
  // actually withheld.
  const taxableIncome = Math.max(0, taxableGross - ssnitEmployee);
  const paye = applyPaye ? calculatePaye(taxableIncome, payeBands) : 0;
  const totalDeductions = round2(ssnitEmployee + paye);
  const net = round2(taxableGross - totalDeductions);

  return {
    gross_salary: gross,
    allowances,
    taxable_gross: taxableGross,
    ssnit_employee: ssnitEmployee,
    ssnit_employer: ssnitEmployer,
    ssnit_tier1: tier1,
    ssnit_tier2: tier2,
    paye,
    statutory_deductions: totalDeductions,
    net_salary: net,
    deductions: totalDeductions,
    // What the employee's line should say, given the rate actually applied.
    employee_rate: rates.employee_rate,
  };
}

module.exports = {
  calculatePaye,
  calculateStatutory,
};
