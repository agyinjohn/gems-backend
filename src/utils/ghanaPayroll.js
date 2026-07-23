/**
 * Ghana payroll statutory calculations (simplified).
 * SSNIT employee contribution: 5.5% of gross (Tier 1).
 * PAYE: progressive monthly tax bands (GHS).
 */

const SSNIT_EMPLOYEE_RATE = 0.055;
const SSNIT_EMPLOYER_RATE = 0.13;

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Monthly PAYE bands (simplified Ghana 2024-style monthly equivalents). */
function calculatePaye(taxableMonthly) {
  const income = Math.max(0, taxableMonthly);
  let tax = 0;
  const bands = [
    { upTo: 490, rate: 0 },
    { upTo: 600, rate: 0.05 },
    { upTo: 730, rate: 0.1 },
    { upTo: 3896.67, rate: 0.175 },
    { upTo: 19896.67, rate: 0.25 },
    { upTo: Infinity, rate: 0.3 },
  ];
  let prev = 0;
  for (const band of bands) {
    const slice = Math.min(income, band.upTo) - prev;
    if (slice <= 0) break;
    tax += slice * band.rate;
    prev = band.upTo;
    if (income <= band.upTo) break;
  }
  return round2(tax);
}

/**
 * @param {object} options
 * @param {boolean} [options.applySsnit=true] - false for tenants that don't run
 *   formal SSNIT (e.g. informal/non-registered employers).
 * @param {boolean} [options.applyPaye=true] - false for tenants that don't
 *   withhold income tax.
 */
function calculateStatutory(grossSalary, extraAllowances = 0, options = {}) {
  const { applySsnit = true, applyPaye = true } = options;
  const gross = round2(parseFloat(grossSalary) || 0);
  const allowances = round2(parseFloat(extraAllowances) || 0);
  const taxableGross = gross + allowances;
  const ssnitEmployee = applySsnit ? round2(taxableGross * SSNIT_EMPLOYEE_RATE) : 0;
  const ssnitEmployer = applySsnit ? round2(taxableGross * SSNIT_EMPLOYER_RATE) : 0;
  // PAYE relief for the SSNIT employee contribution only applies if it was
  // actually withheld.
  const taxableIncome = Math.max(0, taxableGross - ssnitEmployee);
  const paye = applyPaye ? calculatePaye(taxableIncome) : 0;
  const totalDeductions = round2(ssnitEmployee + paye);
  const net = round2(taxableGross - totalDeductions);

  return {
    gross_salary: gross,
    allowances,
    taxable_gross: taxableGross,
    ssnit_employee: ssnitEmployee,
    ssnit_employer: ssnitEmployer,
    paye,
    statutory_deductions: totalDeductions,
    net_salary: net,
    deductions: totalDeductions,
  };
}

module.exports = {
  calculatePaye,
  calculateStatutory,
  SSNIT_EMPLOYEE_RATE,
  SSNIT_EMPLOYER_RATE,
};
