const mongoose = require('mongoose');
const { Employee, User, Department, LeaveRequest, PayrollRun, PayrollBatch, EmployeeLoan, LeaveType, PublicHoliday, Attendance, Tenant } = require('../models');
const { calculateStatutory } = require('../utils/ghanaPayroll');
const { uploadHrFile } = require('./uploadService');

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalizeRefId(value) {
  if (value === undefined || value === null || value === '') return null;
  const str = String(value).trim();
  return str || null;
}

// ── PUBLIC HOLIDAYS ──────────────────────────────────────────────────────────
// Excluded from leave-day counts (see leaveDays) and used to distinguish an
// unworked holiday from an unexplained absence.

function ymd(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

async function createHoliday(tenantId, { name, date, is_recurring }, userId) {
  if (!name || !date) throw httpError('name and date are required.');
  return PublicHoliday.create({ tenant_id: tenantId, name, date: new Date(date), is_recurring: !!is_recurring, created_by: userId });
}

async function deleteHoliday(tenantId, id) {
  const holiday = await PublicHoliday.findOneAndDelete({ _id: id, tenant_id: tenantId });
  if (!holiday) throw httpError('Holiday not found.', 404);
  return holiday;
}

/** Holidays for a given year — recurring ones are remapped onto that year. */
async function listHolidays(tenantId, year) {
  const all = await PublicHoliday.find({ tenant_id: tenantId }).sort({ date: 1 });
  if (!year) return all;
  const y = parseInt(year, 10);
  return all
    .map((h) => {
      if (!h.is_recurring) return h;
      const d = new Date(h.date);
      const mapped = new Date(y, d.getMonth(), d.getDate());
      return { ...h.toJSON(), id: h._id, date: mapped };
    })
    .filter((h) => h.is_recurring || new Date(h.date).getFullYear() === y);
}

/** Set of 'YYYY-MM-DD' strings that are public holidays anywhere in [start, end]. */
async function getHolidaySet(tenantId, start, end) {
  const startYear = new Date(start).getFullYear();
  const endYear = new Date(end).getFullYear();
  const years = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);
  const perYear = await Promise.all(years.map((y) => listHolidays(tenantId, y)));
  const set = new Set();
  for (const list of perYear) {
    for (const h of list) {
      const d = ymd(h.date);
      if (d >= ymd(start) && d <= ymd(end)) set.add(d);
    }
  }
  return set;
}

// ── LEAVE TYPES ──────────────────────────────────────────────────────────────
// Tenant-configurable leave categories, each with its own entitlement — so
// maternity/paternity/compassionate/study leave don't silently share (and get
// blocked by) the annual-leave bucket.

const DEFAULT_LEAVE_TYPES = [
  { name: 'Annual Leave',       code: 'annual',       default_days: 21, paid: true },
  { name: 'Sick Leave',         code: 'sick',         default_days: 10, paid: true },
  { name: 'Maternity Leave',    code: 'maternity',    default_days: 84, paid: true },
  { name: 'Paternity Leave',    code: 'paternity',    default_days: 7,  paid: true },
  { name: 'Compassionate Leave',code: 'compassionate',default_days: 5,  paid: true },
  { name: 'Study Leave',        code: 'study',        default_days: 10, paid: false },
  { name: 'Unpaid Leave',       code: 'unpaid',       default_days: 0,  paid: false },
];

/** Lazily seeds a tenant's default leave types the first time they're listed. */
async function listLeaveTypes(tenantId) {
  let types = await LeaveType.find({ tenant_id: tenantId }).sort('name');
  if (!types.length) {
    await LeaveType.insertMany(DEFAULT_LEAVE_TYPES.map((d) => ({ tenant_id: tenantId, ...d })));
    types = await LeaveType.find({ tenant_id: tenantId }).sort('name');
  }
  return types;
}

async function createLeaveType(tenantId, { name, code, default_days, paid }, userId) {
  if (!name) throw httpError('name is required.');
  const slug = (code || name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const exists = await LeaveType.findOne({ tenant_id: tenantId, code: slug });
  if (exists) throw httpError('A leave type with this code already exists.');
  return LeaveType.create({
    tenant_id: tenantId, name, code: slug,
    default_days: Math.max(0, parseInt(default_days, 10) || 0),
    paid: paid !== false, created_by: userId,
  });
}

async function updateLeaveType(tenantId, id, { name, default_days, paid, is_active }) {
  const type = await LeaveType.findOne({ _id: id, tenant_id: tenantId });
  if (!type) throw httpError('Leave type not found.', 404);
  if (name !== undefined) type.name = name;
  if (default_days !== undefined) type.default_days = Math.max(0, parseInt(default_days, 10) || 0);
  if (paid !== undefined) type.paid = !!paid;
  if (is_active !== undefined) type.is_active = !!is_active;
  await type.save();
  return type;
}

/** Working days (excludes weekends and public holidays) between two dates, inclusive. */
async function leaveDays(tenantId, start, end) {
  const holidays = await getHolidaySet(tenantId, start, end);
  let count = 0;
  const cursor = new Date(start);
  const last = new Date(end);
  while (cursor <= last) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(ymd(cursor))) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

const DEFAULT_ANNUAL_ENTITLEMENT = 21;
const DEFAULT_SICK_ENTITLEMENT = 10;

/**
 * Per-leave-type balances for an employee. `leaveTypes` should be fetched once
 * (via listLeaveTypes) and passed in — callers that build balances for many
 * employees at once (listEmployees) must not re-fetch it per employee.
 */
function getLeaveBalances(employee, leaveTypes = []) {
  const entitlements = employee.leave_entitlements || [];
  const byCode = Object.fromEntries(entitlements.map((e) => [e.code, e]));

  return leaveTypes.filter((lt) => lt.is_active !== false).map((lt) => {
    const existing = byCode[lt.code];
    let entitlement_days = existing?.entitlement_days ?? lt.default_days;
    let used_days = existing?.used_days ?? 0;
    // Fall back to the legacy annual/sick fields when no per-type entry has
    // been created yet for this employee (pre-migration data).
    if (!existing && lt.code === 'annual') {
      entitlement_days = employee.annual_leave_entitlement ?? lt.default_days ?? DEFAULT_ANNUAL_ENTITLEMENT;
      used_days = employee.leave_balances?.annual_used ?? 0;
    } else if (!existing && lt.code === 'sick') {
      entitlement_days = employee.sick_leave_entitlement ?? lt.default_days ?? DEFAULT_SICK_ENTITLEMENT;
      used_days = employee.leave_balances?.sick_used ?? 0;
    }
    return {
      code: lt.code,
      name: lt.name,
      paid: lt.paid,
      entitlement_days,
      used_days,
      remaining_days: Math.max(0, entitlement_days - used_days),
    };
  });
}

/** Sum of outstanding active-loan balances per employee id. */
async function getActiveLoanBalances(tenantId, employeeIds) {
  if (!employeeIds.length) return {};
  const rows = await EmployeeLoan.aggregate([
    { $match: { tenant_id: new mongoose.Types.ObjectId(tenantId), employee_id: { $in: employeeIds }, status: 'active' } },
    { $group: { _id: '$employee_id', balance: { $sum: '$balance' } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.balance]));
}

async function listEmployees(tenantId, branchFilter = {}) {
  const data = await Employee.find({ tenant_id: tenantId, ...branchFilter })
    .populate('department_id', 'name')
    .populate('manager_id', 'name employee_code')
    .populate('user_id', 'name email role')
    .sort('name');
  const [loanMap, leaveTypes] = await Promise.all([
    getActiveLoanBalances(tenantId, data.map((e) => e._id)),
    listLeaveTypes(tenantId),
  ]);
  return data.map((e) => {
    const json = e.toJSON();
    return {
      ...json,
      id: json._id,
      department_name: e.department_id?.name || null,
      manager_name: e.manager_id?.name || null,
      linked_user: e.user_id ? { id: e.user_id._id, name: e.user_id.name, email: e.user_id.email, role: e.user_id.role } : null,
      leave_balance: getLeaveBalances(e, leaveTypes),
      active_loan_balance: loanMap[String(e._id)] || 0,
    };
  });
}

async function getEmployee(tenantId, id) {
  const e = await Employee.findOne({ _id: id, tenant_id: tenantId })
    .populate('department_id', 'name')
    .populate('manager_id', 'name employee_code')
    .populate('user_id', 'name email role');
  if (!e) throw httpError('Employee not found.', 404);
  const [loanMap, leaveTypes] = await Promise.all([
    getActiveLoanBalances(tenantId, [e._id]),
    listLeaveTypes(tenantId),
  ]);
  const json = e.toJSON();
  return {
    ...json,
    id: json._id,
    department_name: e.department_id?.name || null,
    manager_name: e.manager_id?.name || null,
    linked_user: e.user_id ? { id: e.user_id._id, name: e.user_id.name, email: e.user_id.email, role: e.user_id.role } : null,
    leave_balance: getLeaveBalances(e, leaveTypes),
    active_loan_balance: loanMap[String(e._id)] || 0,
  };
}

async function assertUserLinkable(tenantId, userId, employeeId = null) {
  if (!userId) return null;
  const user = await User.findOne({ _id: userId, tenant_id: tenantId, is_active: true });
  if (!user) throw httpError('Linked user not found or inactive.');
  const existing = await Employee.findOne({ tenant_id: tenantId, user_id: userId });
  if (existing && String(existing._id) !== String(employeeId || '')) {
    throw httpError('This user is already linked to another employee.');
  }
  return user._id;
}

async function listLinkableUsers(tenantId, employeeId = null) {
  const linked = await Employee.find({ tenant_id: tenantId, user_id: { $ne: null } }).select('user_id');
  const exclude = linked
    .map((e) => String(e.user_id))
    .filter((id) => id && id !== 'null');
  if (employeeId) {
    const current = await Employee.findOne({ _id: employeeId, tenant_id: tenantId });
    if (current?.user_id) {
      const idx = exclude.indexOf(String(current.user_id));
      if (idx >= 0) exclude.splice(idx, 1);
    }
  }
  return User.find(
    { tenant_id: tenantId, is_active: true, _id: { $nin: exclude } },
    'name email role',
  ).sort('name');
}

async function createEmployee(tenantId, body) {
  const {
    name, email, phone, department_id, job_title, gross_salary, start_date, employee_code,
    photo, date_of_birth, gender, nationality, marital_status, national_id, address, employment_type,
    emergency_name, emergency_phone, emergency_relation, user_id, manager_id, branch_id,
    annual_leave_entitlement, sick_leave_entitlement,
    ssnit_number, tin, payment_method, bank_name, bank_account_name, bank_account_number, bank_branch, momo_number,
  } = body;
  if (!name || gross_salary === undefined) throw httpError('name and gross_salary required.');
  const linkedUserId = await assertUserLinkable(tenantId, normalizeRefId(user_id));
  const code = employee_code?.trim() || `EMP-${Date.now().toString().slice(-6)}`;
  return Employee.create({
    tenant_id: tenantId,
    branch_id: normalizeRefId(branch_id),
    user_id: linkedUserId,
    manager_id: normalizeRefId(manager_id),
    employee_code: code,
    name,
    email,
    phone,
    department_id: normalizeRefId(department_id),
    job_title,
    gross_salary,
    start_date: start_date || null,
    photo,
    date_of_birth: date_of_birth || null,
    gender: gender || undefined,
    nationality,
    marital_status: marital_status || undefined,
    national_id,
    address,
    employment_type: employment_type || 'full_time',
    emergency_name,
    emergency_phone,
    emergency_relation,
    ssnit_number,
    tin,
    payment_method: payment_method || 'bank',
    bank_name,
    bank_account_name,
    bank_account_number,
    bank_branch,
    momo_number,
    annual_leave_entitlement: annual_leave_entitlement ?? DEFAULT_ANNUAL_ENTITLEMENT,
    sick_leave_entitlement: sick_leave_entitlement ?? DEFAULT_SICK_ENTITLEMENT,
    leave_balances: { annual_used: 0, sick_used: 0 },
    status: 'active',
  });
}

async function updateEmployee(tenantId, id, body) {
  const emp = await Employee.findOne({ _id: id, tenant_id: tenantId });
  if (!emp) throw httpError('Employee not found.', 404);

  const allowed = [
    'name', 'email', 'phone', 'department_id', 'job_title', 'gross_salary', 'start_date', 'status',
    'photo', 'date_of_birth', 'gender', 'nationality', 'marital_status', 'national_id', 'address', 'employment_type',
    'emergency_name', 'emergency_phone', 'emergency_relation', 'manager_id', 'branch_id',
    'annual_leave_entitlement', 'sick_leave_entitlement',
    'ssnit_number', 'tin', 'payment_method', 'bank_name', 'bank_account_name',
    'bank_account_number', 'bank_branch', 'momo_number',
  ];
  const refFields = ['department_id', 'manager_id', 'branch_id'];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      emp[key] = refFields.includes(key) ? normalizeRefId(body[key]) : body[key];
    }
  }
  if (body.user_id !== undefined) {
    emp.user_id = await assertUserLinkable(tenantId, normalizeRefId(body.user_id), id);
  }
  await emp.save();
  return getEmployee(tenantId, id);
}

async function terminateEmployee(tenantId, id, { end_date, reason }) {
  const emp = await Employee.findOne({ _id: id, tenant_id: tenantId });
  if (!emp) throw httpError('Employee not found.', 404);
  if (emp.status === 'terminated') throw httpError('Employee is already terminated.');
  emp.status = 'terminated';
  emp.end_date = end_date ? new Date(end_date) : new Date();
  emp.termination_reason = reason || '';
  emp.user_id = null;
  await emp.save();
  return emp;
}

function slugifyLeaveType(value) {
  return String(value || 'annual').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

async function approveLeaveRequest(tenantId, leaveId, reviewerId, status) {
  const leave = await LeaveRequest.findOne({ _id: leaveId, tenant_id: tenantId });
  if (!leave) throw httpError('Leave request not found.', 404);
  if (!['approved', 'rejected'].includes(status)) throw httpError('Invalid status.');

  if (status === 'approved' && leave.status === 'pending') {
    const emp = await Employee.findById(leave.employee_id);
    if (!emp) throw httpError('Employee not found.');

    const days = await leaveDays(tenantId, leave.start_date, leave.end_date);
    const code = slugifyLeaveType(leave.leave_type);
    const leaveTypes = await listLeaveTypes(tenantId);
    const leaveType = leaveTypes.find((lt) => lt.code === code);

    // Types with no entitlement (unpaid, or an unrecognised/custom label)
    // aren't balance-checked — same as the old 'unpaid'/'other' exemption.
    if (leaveType && leaveType.default_days > 0) {
      if (!emp.leave_entitlements) emp.leave_entitlements = [];
      let entry = emp.leave_entitlements.find((e) => e.code === code);
      if (!entry) {
        // Seed from the legacy fields for annual/sick so existing balances
        // aren't lost; otherwise start from the tenant's default.
        let entitlement_days = leaveType.default_days;
        let used_days = 0;
        if (code === 'annual') {
          entitlement_days = emp.annual_leave_entitlement ?? leaveType.default_days;
          used_days = emp.leave_balances?.annual_used ?? 0;
        } else if (code === 'sick') {
          entitlement_days = emp.sick_leave_entitlement ?? leaveType.default_days;
          used_days = emp.leave_balances?.sick_used ?? 0;
        }
        entry = emp.leave_entitlements.create
          ? emp.leave_entitlements.create({ code, entitlement_days, used_days })
          : { code, entitlement_days, used_days };
        emp.leave_entitlements.push(entry);
      }
      if (entry.used_days + days > entry.entitlement_days) {
        throw httpError(`Insufficient ${leaveType.name.toLowerCase()}. ${Math.max(0, entry.entitlement_days - entry.used_days)} day(s) remaining.`);
      }
      entry.used_days += days;
    }
    await emp.save();
  }

  leave.status = status;
  leave.reviewed_by = reviewerId;
  await leave.save();
  return leave;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function normalizePayLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((line) => ({
      name: String(line.name || '').trim(),
      amount: round2(parseFloat(line.amount) || 0),
    }))
    .filter((line) => line.name && line.amount > 0);
}

// ── PRO-RATION ─────────────────────────────────────────────────────────────
// Mid-period joiners/leavers are paid for the days they were actually
// employed within the pay period, not a full month.

function stripTime(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function periodBounds(month, year) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0); // last day of the month
  return { start: stripTime(start), end: stripTime(end) };
}

function daysInclusive(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

/**
 * Days an employee actually worked within the pay period, based on
 * start_date (joined mid-period) and end_date (terminated mid-period).
 * workedDays === 0 means the employee was not employed at all during this
 * period (e.g. hired after it ended, or terminated before it began).
 *
 * Intentionally returns raw day counts rather than a pre-divided/rounded
 * factor — rounding a fraction before multiplying it into a salary can shift
 * the prorated amount by several currency units; the division only happens
 * once, at the point the prorated gross is computed.
 */
function calcProration(emp, month, year) {
  const { start, end } = periodBounds(month, year);
  const totalDays = daysInclusive(start, end);

  let workStart = start;
  let workEnd = end;
  if (emp.start_date) {
    const sd = stripTime(emp.start_date);
    if (sd > workStart) workStart = sd;
  }
  if (emp.end_date && emp.status === 'terminated') {
    const ed = stripTime(emp.end_date);
    if (ed < workEnd) workEnd = ed;
  }

  if (workStart > workEnd) return { workedDays: 0, isProrated: false, totalDays };
  const workedDays = daysInclusive(workStart, workEnd);
  return { workedDays, isProrated: workedDays < totalDays, totalDays };
}

/** Active employees (status='active') plus anyone terminated mid-period, so
 * a leaver still gets one final, prorated pay run for their last month. */
async function getPayrollEligibleEmployees(tenantId, month, year, branchFilter = {}) {
  const { start, end } = periodBounds(month, year);
  const [active, exited] = await Promise.all([
    Employee.find({ tenant_id: tenantId, status: 'active', ...branchFilter }),
    Employee.find({ tenant_id: tenantId, status: 'terminated', end_date: { $gte: start, $lte: end }, ...branchFilter }),
  ]);
  return [...active, ...exited];
}

// ── EMPLOYEE LOANS / SALARY ADVANCES ────────────────────────────────────────

async function createLoan(tenantId, body) {
  const { employee_id, type, reason, principal, monthly_deduction, disbursed_date } = body;
  const emp = await Employee.findOne({ _id: employee_id, tenant_id: tenantId });
  if (!emp) throw httpError('Employee not found.', 404);
  const p = round2(parseFloat(principal));
  const m = round2(parseFloat(monthly_deduction));
  if (!p || p <= 0) throw httpError('principal must be greater than zero.');
  if (!m || m <= 0) throw httpError('monthly_deduction must be greater than zero.');
  return EmployeeLoan.create({
    tenant_id: tenantId,
    branch_id: emp.branch_id || null,
    employee_id: emp._id,
    type: type === 'advance' ? 'advance' : 'loan',
    reason: reason || '',
    principal: p,
    balance: p,
    monthly_deduction: m,
    disbursed_date: disbursed_date || new Date(),
  });
}

async function listLoans(tenantId, { employee_id, status } = {}, branchFilter = {}) {
  const filter = { tenant_id: tenantId, ...branchFilter };
  if (employee_id) filter.employee_id = employee_id;
  if (status) filter.status = status;
  const loans = await EmployeeLoan.find(filter).populate('employee_id', 'name employee_code').sort({ createdAt: -1 });
  return loans.map((l) => ({ ...l.toJSON(), employee_name: l.employee_id?.name || '—' }));
}

async function getLoan(tenantId, id) {
  const loan = await EmployeeLoan.findOne({ _id: id, tenant_id: tenantId }).populate('employee_id', 'name employee_code');
  if (!loan) throw httpError('Loan not found.', 404);
  return { ...loan.toJSON(), employee_name: loan.employee_id?.name || '—' };
}

async function cancelLoan(tenantId, id) {
  const loan = await EmployeeLoan.findOne({ _id: id, tenant_id: tenantId });
  if (!loan) throw httpError('Loan not found.', 404);
  if (loan.status !== 'active') throw httpError('Only an active loan can be cancelled.');
  loan.status = 'cancelled';
  await loan.save();
  return loan;
}

async function getActiveLoansForEmployee(tenantId, employeeId) {
  return EmployeeLoan.find({ tenant_id: tenantId, employee_id: employeeId, status: 'active' }).sort({ createdAt: 1 });
}

/** Deduction lines for this pay run — capped at whatever balance remains. */
function loanDeductionLines(loans) {
  return loans
    .map((loan) => ({
      name: `${loan.type === 'advance' ? 'Advance' : 'Loan'} repayment${loan.reason ? ` (${loan.reason})` : ''}`,
      amount: round2(Math.min(loan.monthly_deduction, loan.balance)),
      loan_id: loan._id,
    }))
    .filter((line) => line.amount > 0);
}

/** After a payroll run is created, apply its loan deduction lines to the
 * loan balances and record the repayment. */
async function commitLoanRepayments(tenantId, loanLines, payrollRunId, month, year) {
  for (const line of loanLines) {
    const loan = await EmployeeLoan.findOne({ _id: line.loan_id, tenant_id: tenantId });
    if (!loan) continue;
    loan.balance = round2(Math.max(0, loan.balance - line.amount));
    loan.repayments.push({ month, year, amount: line.amount, payroll_run_id: payrollRunId, date: new Date() });
    if (loan.balance <= 0) loan.status = 'completed';
    await loan.save();
  }
}

/** Proration + active-loan deductions + statutory calc for one employee. */
async function computePayrollForEmployee(tenantId, emp, month, year, allowanceLines, sharedDeductionLines, settings) {
  const proration = calcProration(emp, month, year);
  if (proration.workedDays <= 0) throw httpError(`${emp.name} was not employed during this period.`);

  const loans = await getActiveLoansForEmployee(tenantId, emp._id);
  const loanLines = loanDeductionLines(loans);
  const proratedGross = proration.isProrated
    ? round2(emp.gross_salary * (proration.workedDays / proration.totalDays))
    : emp.gross_salary;

  const amounts = buildPayrollAmounts(proratedGross, allowanceLines, [...sharedDeductionLines, ...loanLines], settings);
  return { amounts, proration };
}

/** Tenant's statutory payroll toggles, merged with defaults (both on). */
async function getPayrollSettings(tenantId) {
  const tenant = await Tenant.findById(tenantId).select('payroll_settings');
  return {
    applySsnit: tenant?.payroll_settings?.apply_ssnit ?? true,
    applyPaye: tenant?.payroll_settings?.apply_paye ?? true,
  };
}

async function updatePayrollSettings(tenantId, { apply_ssnit, apply_paye }) {
  const update = {};
  if (apply_ssnit !== undefined) update['payroll_settings.apply_ssnit'] = !!apply_ssnit;
  if (apply_paye !== undefined) update['payroll_settings.apply_paye'] = !!apply_paye;
  const tenant = await Tenant.findByIdAndUpdate(tenantId, { $set: update }, { new: true }).select('payroll_settings');
  return {
    apply_ssnit: tenant?.payroll_settings?.apply_ssnit ?? true,
    apply_paye: tenant?.payroll_settings?.apply_paye ?? true,
  };
}

// ── ATTENDANCE — CLOCK IN/OUT ────────────────────────────────────────────────

async function getAttendanceSettings(tenantId) {
  const tenant = await Tenant.findById(tenantId).select('attendance_settings');
  return { standardHoursPerDay: tenant?.attendance_settings?.standard_hours_per_day ?? 8 };
}

async function updateAttendanceSettings(tenantId, { standard_hours_per_day }) {
  const hours = parseFloat(standard_hours_per_day);
  if (!hours || hours <= 0) throw httpError('standard_hours_per_day must be greater than zero.');
  const tenant = await Tenant.findByIdAndUpdate(
    tenantId,
    { $set: { 'attendance_settings.standard_hours_per_day': hours } },
    { new: true },
  ).select('attendance_settings');
  return { standard_hours_per_day: tenant.attendance_settings.standard_hours_per_day };
}

function todayBounds() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);
  return { start, end };
}

function computeHours(clockIn, clockOut, standardHoursPerDay) {
  const hoursWorked = round2(Math.max(0, (new Date(clockOut) - new Date(clockIn)) / 3600000));
  const overtimeHours = round2(Math.max(0, hoursWorked - standardHoursPerDay));
  return { hoursWorked, overtimeHours };
}

async function clockIn(tenantId, employeeId, branchId) {
  const { start, end } = todayBounds();
  let record = await Attendance.findOne({ tenant_id: tenantId, employee_id: employeeId, date: { $gte: start, $lte: end } });
  if (record?.clock_in && !record?.clock_out) throw httpError('Already clocked in today.');
  if (record) {
    record.clock_in = new Date();
    record.clock_out = undefined;
    record.hours_worked = undefined;
    record.overtime_hours = undefined;
    record.status = 'present';
    await record.save();
  } else {
    record = await Attendance.create({
      tenant_id: tenantId, branch_id: branchId || null, employee_id: employeeId,
      date: start, status: 'present', clock_in: new Date(),
    });
  }
  return record;
}

async function clockOut(tenantId, employeeId) {
  const { start, end } = todayBounds();
  const record = await Attendance.findOne({ tenant_id: tenantId, employee_id: employeeId, date: { $gte: start, $lte: end } });
  if (!record || !record.clock_in) throw httpError('You have not clocked in today.');
  if (record.clock_out) throw httpError('Already clocked out today.');
  const { standardHoursPerDay } = await getAttendanceSettings(tenantId);
  record.clock_out = new Date();
  const { hoursWorked, overtimeHours } = computeHours(record.clock_in, record.clock_out, standardHoursPerDay);
  record.hours_worked = hoursWorked;
  record.overtime_hours = overtimeHours;
  await record.save();
  return record;
}

function buildPayrollAmounts(grossSalary, allowanceLines, extraDeductionLines, settings = {}) {
  const allowanceTotal = round2(allowanceLines.reduce((sum, line) => sum + line.amount, 0));
  const statutory = calculateStatutory(grossSalary, allowanceTotal, settings);
  const statutoryDeductions = [
    { name: 'PAYE', amount: statutory.paye },
    { name: 'SSNIT (employee 5.5%)', amount: statutory.ssnit_employee },
  ];
  const deductionLines = [
    ...statutoryDeductions,
    ...extraDeductionLines,
  ].filter((line) => line.amount > 0);
  const deductionTotal = round2(deductionLines.reduce((sum, line) => sum + line.amount, 0));
  const net = round2(statutory.gross_salary + allowanceTotal - deductionTotal);

  return {
    gross_salary: statutory.gross_salary,
    allowances: allowanceTotal,
    allowance_lines: allowanceLines,
    deductions: deductionTotal,
    deduction_lines: deductionLines,
    paye: statutory.paye,
    ssnit_employee: statutory.ssnit_employee,
    ssnit_employer: statutory.ssnit_employer,
    net_salary: net,
  };
}

async function runPayroll(tenantId, { employee_id, month, year, allowance_lines = [], deduction_lines = [] }, settings) {
  // Not restricted to status:'active' — a just-terminated employee still
  // needs one final, prorated run for their last month.
  const emp = await Employee.findOne({ _id: employee_id, tenant_id: tenantId });
  if (!emp) throw httpError('Employee not found.', 404);

  const existing = await PayrollRun.findOne({ tenant_id: tenantId, employee_id, month, year });
  if (existing) throw httpError('Payroll already exists for this employee and period.');

  const payrollSettings = settings || await getPayrollSettings(tenantId);
  const { amounts, proration } = await computePayrollForEmployee(
    tenantId, emp, month, year,
    normalizePayLines(allowance_lines),
    normalizePayLines(deduction_lines),
    payrollSettings,
  );

  const run = await PayrollRun.create({
    tenant_id: tenantId,
    branch_id: emp.branch_id || null,
    employee_id,
    month,
    year,
    status: 'submitted',
    ...(proration.isProrated ? { proration: { worked_days: proration.workedDays, total_days: proration.totalDays, full_gross_salary: emp.gross_salary } } : {}),
    ...amounts,
  });

  await commitLoanRepayments(tenantId, amounts.deduction_lines.filter((l) => l.loan_id), run._id, month, year);
  return run;
}

async function runBulkPayroll(tenantId, { month, year, allowance_lines = [], deduction_lines = [] }) {
  const employees = await getPayrollEligibleEmployees(tenantId, month, year);
  const sharedAllowances = normalizePayLines(allowance_lines);
  const sharedDeductions = normalizePayLines(deduction_lines);
  const payrollSettings = await getPayrollSettings(tenantId);
  const results = { created: [], skipped: [], errors: [] };

  for (const emp of employees) {
    try {
      const existing = await PayrollRun.findOne({ tenant_id: tenantId, employee_id: emp._id, month, year });
      if (existing) {
        results.skipped.push({ employee_id: emp._id, name: emp.name, reason: 'Already exists' });
        continue;
      }
      const row = await runPayroll(tenantId, {
        employee_id: emp._id,
        month,
        year,
        allowance_lines: sharedAllowances,
        deduction_lines: sharedDeductions,
      }, payrollSettings);
      results.created.push({ employee_id: emp._id, name: emp.name, payroll_id: row._id });
    } catch (err) {
      results.errors.push({ employee_id: emp._id, name: emp.name, message: err.message });
    }
  }
  return results;
}

async function uploadEmployeeDocument(tenantId, employeeId, file) {
  const emp = await Employee.findOne({ _id: employeeId, tenant_id: tenantId });
  if (!emp) throw httpError('Employee not found.', 404);
  return uploadHrFile(tenantId, employeeId, file);
}

async function addEmployeeDocument(tenantId, employeeId, { name, type, url, mime_type }) {
  const emp = await Employee.findOne({ _id: employeeId, tenant_id: tenantId });
  if (!emp) throw httpError('Employee not found.', 404);
  emp.documents.push({
    name,
    type: type || 'other',
    file: url,
    mime_type: mime_type || null,
    uploaded_at: new Date(),
  });
  await emp.save();
  return emp.documents;
}

async function deleteEmployeeDocument(tenantId, employeeId, docId) {
  const emp = await Employee.findOne({ _id: employeeId, tenant_id: tenantId });
  if (!emp) throw httpError('Employee not found.', 404);
  emp.documents = emp.documents.filter((d) => String(d._id) !== String(docId));
  await emp.save();
}

// Next month/day occurrence of `dateStr` on/after `today` (this year, or next year if already passed).
function nextAnnualOccurrence(dateStr, today) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  let next = new Date(today.getFullYear(), d.getMonth(), d.getDate());
  next.setHours(0, 0, 0, 0);
  if (next < today) next = new Date(today.getFullYear() + 1, d.getMonth(), d.getDate());
  return next;
}
function daysUntilAnnual(dateStr, today) {
  const next = nextAnnualOccurrence(dateStr, today);
  return next ? Math.round((next - today) / 86400000) : null;
}

async function getHrSummary(tenantId, query = {}, branchFilter = {}) {
  const bf = branchFilter || {};
  const employees = await Employee.find({ tenant_id: tenantId, ...bf }).populate('department_id', 'name');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [onLeaveList, pendingLeaveList, attendanceToday, payrollAgg, payrollTrendAgg, loanAgg] = await Promise.all([
    LeaveRequest.find({
      tenant_id: tenantId,
      ...bf,
      status: 'approved',
      start_date: { $lte: today },
      end_date: { $gte: today },
    }).populate('employee_id', 'name'),
    LeaveRequest.find({ tenant_id: tenantId, ...bf, status: 'pending' })
      .populate('employee_id', 'name').sort({ createdAt: -1 }),
    Attendance.countDocuments({ tenant_id: tenantId, ...bf, date: today }),
    PayrollRun.aggregate([
      { $match: { tenant_id: tenantId, ...bf, status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$net_salary' }, runs: { $sum: 1 } } },
    ]),
    PayrollRun.aggregate([
      { $match: { tenant_id: tenantId, ...bf, status: { $in: ['approved', 'paid'] } } },
      { $group: { _id: { month: '$month', year: '$year' }, total: { $sum: '$net_salary' } } },
      { $sort: { '_id.year': -1, '_id.month': -1 } },
      { $limit: 6 },
    ]),
    EmployeeLoan.aggregate([
      { $match: { tenant_id: tenantId, ...bf, status: 'active' } },
      { $group: { _id: null, total: { $sum: '$balance' }, count: { $sum: 1 } } },
    ]),
  ]);

  const activeEmployees = employees.filter((e) => e.status === 'active');

  const deptCounts = new Map();
  const typeCounts = new Map();
  for (const e of activeEmployees) {
    const dept = e.department_id?.name || 'Unassigned';
    deptCounts.set(dept, (deptCounts.get(dept) || 0) + 1);
    const type = e.employment_type || 'full_time';
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  }

  const upcomingBirthdays = activeEmployees
    .map((e) => ({ name: e.name, date: e.date_of_birth, days_until: daysUntilAnnual(e.date_of_birth, today) }))
    .filter((e) => e.days_until !== null && e.days_until <= 30)
    .sort((a, b) => a.days_until - b.days_until)
    .slice(0, 5);

  const upcomingAnniversaries = activeEmployees
    .map((e) => {
      const next = nextAnnualOccurrence(e.start_date, today);
      if (!next) return null;
      const years = next.getFullYear() - new Date(e.start_date).getFullYear();
      return { name: e.name, start_date: e.start_date, days_until: Math.round((next - today) / 86400000), years };
    })
    .filter((e) => e && e.days_until <= 30 && e.years > 0)
    .sort((a, b) => a.days_until - b.days_until)
    .slice(0, 5);

  return {
    total_employees: employees.length,
    active: activeEmployees.length,
    terminated: employees.filter((e) => e.status === 'terminated').length,
    on_leave: onLeaveList.length,
    on_leave_list: onLeaveList.slice(0, 10).map((l) => ({
      employee_name: l.employee_id?.name || 'Unknown', leave_type: l.leave_type, end_date: l.end_date,
    })),
    pending_leave: pendingLeaveList.length,
    pending_leave_list: pendingLeaveList.slice(0, 8).map((l) => ({
      id: l._id, employee_name: l.employee_id?.name || 'Unknown', leave_type: l.leave_type,
      start_date: l.start_date, end_date: l.end_date,
    })),
    attendance_today: attendanceToday,
    payroll_total: payrollAgg[0]?.total || 0,
    payroll_runs: payrollAgg[0]?.runs || 0,
    payroll_trend: payrollTrendAgg
      .map((r) => ({ month: r._id.month, year: r._id.year, total: r.total }))
      .reverse(),
    outstanding_loans_total: loanAgg[0]?.total || 0,
    outstanding_loans_count: loanAgg[0]?.count || 0,
    department_breakdown: [...deptCounts.entries()].map(([department, count]) => ({ department, count })).sort((a, b) => b.count - a.count),
    employment_type_breakdown: [...typeCounts.entries()].map(([type, count]) => ({ type, count })),
    upcoming_birthdays: upcomingBirthdays,
    upcoming_anniversaries: upcomingAnniversaries,
  };
}

/** A point-in-time-plus-period HR report: current headcount snapshot, and
 * leave/attendance/payroll/loans activity within [from, to] (inclusive). */
async function getHrReportForRange(tenantId, { from, to } = {}, branchFilter = {}) {
  const bf = branchFilter || {};
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to) { const end = new Date(to); end.setHours(23, 59, 59, 999); range.$lte = end; }
  const rangeMatch = Object.keys(range).length ? { createdAt: range } : {};
  const inRange = (d) => {
    if (!d) return false;
    const t = new Date(d).getTime();
    if (range.$gte && t < range.$gte.getTime()) return false;
    if (range.$lte && t > range.$lte.getTime()) return false;
    return true;
  };

  const employees = await Employee.find({ tenant_id: tenantId, ...bf }).populate('department_id', 'name');
  const activeEmployees = employees.filter((e) => e.status === 'active');

  const deptCounts = new Map();
  const typeCounts = new Map();
  for (const e of activeEmployees) {
    const dept = e.department_id?.name || 'Unassigned';
    deptCounts.set(dept, (deptCounts.get(dept) || 0) + 1);
    const type = e.employment_type || 'full_time';
    typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
  }

  const newHires = employees.filter((e) => inRange(e.start_date));
  const terminations = employees.filter((e) => e.status === 'terminated' && inRange(e.end_date));

  const [leaveByStatusAgg, leaveList, attendanceByStatusAgg, payrollAgg, payrollByMonth, loansDisbursedAgg, loanRepaymentsAgg, outstandingLoansAgg] = await Promise.all([
    LeaveRequest.aggregate([
      { $match: { tenant_id: tenantId, ...bf, ...rangeMatch } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    LeaveRequest.find({ tenant_id: tenantId, ...bf, ...rangeMatch }).populate('employee_id', 'name').sort({ createdAt: -1 }).limit(50),
    Attendance.aggregate([
      { $match: { tenant_id: tenantId, ...bf, ...(Object.keys(range).length ? { date: range } : {}) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    PayrollRun.aggregate([
      { $match: { tenant_id: tenantId, ...bf, status: { $in: ['approved', 'paid'] }, ...rangeMatch } },
      { $group: { _id: null, total: { $sum: '$net_salary' }, runs: { $sum: 1 } } },
    ]),
    PayrollRun.aggregate([
      { $match: { tenant_id: tenantId, ...bf, status: { $in: ['approved', 'paid'] }, ...rangeMatch } },
      { $group: { _id: { month: '$month', year: '$year' }, total: { $sum: '$net_salary' } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]),
    EmployeeLoan.aggregate([
      { $match: { tenant_id: tenantId, ...bf, ...(Object.keys(range).length ? { disbursed_date: range } : {}) } },
      { $group: { _id: null, total: { $sum: '$principal' }, count: { $sum: 1 } } },
    ]),
    EmployeeLoan.aggregate([
      { $match: { tenant_id: tenantId, ...bf } },
      { $unwind: '$repayments' },
      ...(Object.keys(range).length ? [{ $match: { 'repayments.date': range } }] : []),
      { $group: { _id: null, total: { $sum: '$repayments.amount' } } },
    ]),
    EmployeeLoan.aggregate([
      { $match: { tenant_id: tenantId, ...bf, status: 'active' } },
      { $group: { _id: null, total: { $sum: '$balance' }, count: { $sum: 1 } } },
    ]),
  ]);

  const leaveMap = Object.fromEntries(leaveByStatusAgg.map((l) => [l._id, l.count]));
  const attendanceMap = Object.fromEntries(attendanceByStatusAgg.map((a) => [a._id, a.count]));

  return {
    period: { from: from || null, to: to || null },
    total_employees: employees.length,
    active: activeEmployees.length,
    department_breakdown: [...deptCounts.entries()].map(([department, count]) => ({ department, count })).sort((a, b) => b.count - a.count),
    employment_type_breakdown: [...typeCounts.entries()].map(([type, count]) => ({ type, count })),
    new_hires: newHires.map((e) => ({ name: e.name, start_date: e.start_date, department: e.department_id?.name || 'Unassigned' })),
    terminations: terminations.map((e) => ({ name: e.name, end_date: e.end_date, reason: e.termination_reason || '' })),
    leave_by_status: { approved: leaveMap.approved || 0, pending: leaveMap.pending || 0, rejected: leaveMap.rejected || 0 },
    leave_list: leaveList.map((l) => ({
      employee_name: l.employee_id?.name || 'Unknown', leave_type: l.leave_type,
      start_date: l.start_date, end_date: l.end_date, status: l.status,
    })),
    attendance_by_status: {
      present: attendanceMap.present || 0, absent: attendanceMap.absent || 0,
      half_day: attendanceMap.half_day || 0, leave: attendanceMap.leave || 0, holiday: attendanceMap.holiday || 0,
    },
    payroll_total: payrollAgg[0]?.total || 0,
    payroll_runs: payrollAgg[0]?.runs || 0,
    payroll_by_month: payrollByMonth.map((r) => ({ month: r._id.month, year: r._id.year, total: r.total })),
    loans_disbursed_total: loansDisbursedAgg[0]?.total || 0,
    loans_disbursed_count: loansDisbursedAgg[0]?.count || 0,
    loan_repayments_total: loanRepaymentsAgg[0]?.total || 0,
    outstanding_loans_total: outstandingLoansAgg[0]?.total || 0,
    outstanding_loans_count: outstandingLoansAgg[0]?.count || 0,
  };
}

// ── PAYROLL BATCHES (period pay runs) ──────────────────────────────────────
async function recomputeBatchTotals(tenantId, batchId) {
  const runs = await PayrollRun.find({ tenant_id: tenantId, batch_id: batchId });
  const t = runs.reduce((a, r) => ({
    total_gross:          a.total_gross + (r.gross_salary || 0),
    total_allowances:     a.total_allowances + (r.allowances || 0),
    total_deductions:     a.total_deductions + (r.deductions || 0),
    total_paye:           a.total_paye + (r.paye || 0),
    total_ssnit_employee: a.total_ssnit_employee + (r.ssnit_employee || 0),
    total_ssnit_employer: a.total_ssnit_employer + (r.ssnit_employer || 0),
    total_net:            a.total_net + (r.net_salary || 0),
  }), { total_gross: 0, total_allowances: 0, total_deductions: 0, total_paye: 0, total_ssnit_employee: 0, total_ssnit_employer: 0, total_net: 0 });
  await PayrollBatch.findByIdAndUpdate(batchId, { ...t, employee_count: runs.length });
}

/** Run payroll for every active employee in scope, grouped under one batch. */
async function runPayrollBatch(tenantId, { month, year, allowance_lines = [], deduction_lines = [] }, userId, branchFilter = {}) {
  const m = parseInt(month, 10);
  const y = parseInt(year, 10);
  if (!m || !y) throw httpError('month and year are required.');

  const employees = await getPayrollEligibleEmployees(tenantId, m, y, branchFilter);
  if (!employees.length) throw httpError('No active or period-eligible employees to run payroll for.');

  const sharedAllowances = normalizePayLines(allowance_lines);
  const sharedDeductions = normalizePayLines(deduction_lines);
  const branchId = branchFilter.branch_id || null;
  const payrollSettings = await getPayrollSettings(tenantId);

  // Reuse an open draft batch for the same period + scope, else create one.
  let batch = await PayrollBatch.findOne({ tenant_id: tenantId, month: m, year: y, branch_id: branchId, status: 'draft' });
  if (!batch) {
    batch = await PayrollBatch.create({
      tenant_id: tenantId, branch_id: branchId, month: m, year: y,
      label: `${MONTHS[m - 1]} ${y}`, status: 'draft', created_by: userId,
    });
  }

  const result = { created: [], skipped: [], errors: [] };
  for (const emp of employees) {
    try {
      const existing = await PayrollRun.findOne({ tenant_id: tenantId, employee_id: emp._id, month: m, year: y });
      if (existing) { result.skipped.push({ name: emp.name, reason: 'Already has payroll for this period' }); continue; }
      const { amounts, proration } = await computePayrollForEmployee(tenantId, emp, m, y, sharedAllowances, sharedDeductions, payrollSettings);
      const run = await PayrollRun.create({
        tenant_id: tenantId, branch_id: emp.branch_id || null, employee_id: emp._id,
        month: m, year: y, status: 'submitted', batch_id: batch._id,
        ...(proration.isProrated ? { proration: { worked_days: proration.workedDays, total_days: proration.totalDays, full_gross_salary: emp.gross_salary } } : {}),
        ...amounts,
      });
      await commitLoanRepayments(tenantId, amounts.deduction_lines.filter((l) => l.loan_id), run._id, m, y);
      result.created.push({ name: emp.name, payroll_id: run._id });
    } catch (err) {
      result.errors.push({ name: emp.name, message: err.message });
    }
  }

  await recomputeBatchTotals(tenantId, batch._id);
  const fresh = await PayrollBatch.findById(batch._id);
  return { batch: fresh, ...result };
}

async function listPayrollBatches(tenantId, branchFilter = {}) {
  return PayrollBatch.find({ tenant_id: tenantId, ...branchFilter }).sort({ year: -1, month: -1, createdAt: -1 });
}

async function getPayrollBatch(tenantId, id) {
  const batch = await PayrollBatch.findOne({ _id: id, tenant_id: tenantId });
  if (!batch) throw httpError('Pay run not found.', 404);
  const runs = await PayrollRun.find({ tenant_id: tenantId, batch_id: id })
    .populate('employee_id', 'name employee_code payment_method bank_name bank_account_name bank_account_number bank_branch momo_number ssnit_number tin');
  return {
    batch,
    runs: runs.map((r) => ({ ...r.toJSON(), employee_name: r.employee_id?.name || '—', employee: r.employee_id })),
  };
}

async function approvePayrollBatch(tenantId, id, userId) {
  const batch = await PayrollBatch.findOne({ _id: id, tenant_id: tenantId });
  if (!batch) throw httpError('Pay run not found.', 404);
  if (batch.status !== 'draft') throw httpError('Only draft pay runs can be approved.');
  await PayrollRun.updateMany({ tenant_id: tenantId, batch_id: id }, { status: 'approved', approved_by: userId });
  batch.status = 'approved';
  batch.approved_by = userId;
  batch.approved_at = new Date();
  await batch.save();
  return batch;
}

async function markPayrollBatchPaid(tenantId, id) {
  const batch = await PayrollBatch.findOne({ _id: id, tenant_id: tenantId });
  if (!batch) throw httpError('Pay run not found.', 404);
  if (batch.status !== 'approved') throw httpError('Only approved pay runs can be marked paid.');
  await PayrollRun.updateMany({ tenant_id: tenantId, batch_id: id }, { status: 'paid' });
  batch.status = 'paid';
  batch.paid_at = new Date();
  await batch.save();
  return batch;
}

module.exports = {
  listEmployees,
  getEmployee,
  listLinkableUsers,
  createEmployee,
  updateEmployee,
  terminateEmployee,
  approveLeaveRequest,
  runPayroll,
  runBulkPayroll,
  runPayrollBatch,
  listPayrollBatches,
  getPayrollBatch,
  approvePayrollBatch,
  markPayrollBatchPaid,
  getPayrollSettings,
  updatePayrollSettings,
  createLoan,
  listLoans,
  getLoan,
  cancelLoan,
  uploadEmployeeDocument,
  addEmployeeDocument,
  deleteEmployeeDocument,
  getLeaveBalances,
  getHrSummary,
  getHrReportForRange,
  leaveDays,
  listLeaveTypes,
  createLeaveType,
  updateLeaveType,
  createHoliday,
  deleteHoliday,
  listHolidays,
  getAttendanceSettings,
  updateAttendanceSettings,
  clockIn,
  clockOut,
};
