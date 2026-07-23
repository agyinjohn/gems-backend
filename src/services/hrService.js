const { Employee, User, Department, LeaveRequest, PayrollRun, PayrollBatch, Attendance, Tenant } = require('../models');
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

function leaveDays(start, end) {
  return Math.ceil((new Date(end) - new Date(start)) / 86400000) + 1;
}

const DEFAULT_ANNUAL_ENTITLEMENT = 21;
const DEFAULT_SICK_ENTITLEMENT = 10;

function getLeaveBalances(employee) {
  const annualEntitlement = employee.annual_leave_entitlement ?? DEFAULT_ANNUAL_ENTITLEMENT;
  const sickEntitlement = employee.sick_leave_entitlement ?? DEFAULT_SICK_ENTITLEMENT;
  const annualUsed = employee.leave_balances?.annual_used ?? 0;
  const sickUsed = employee.leave_balances?.sick_used ?? 0;
  return {
    annual_entitlement: annualEntitlement,
    sick_entitlement: sickEntitlement,
    annual_remaining: Math.max(0, annualEntitlement - annualUsed),
    sick_remaining: Math.max(0, sickEntitlement - sickUsed),
    annual_used: annualUsed,
    sick_used: sickUsed,
  };
}

async function listEmployees(tenantId, branchFilter = {}) {
  const data = await Employee.find({ tenant_id: tenantId, ...branchFilter })
    .populate('department_id', 'name')
    .populate('manager_id', 'name employee_code')
    .populate('user_id', 'name email role')
    .sort('name');
  return data.map((e) => {
    const json = e.toJSON();
    return {
      ...json,
      id: json._id,
      department_name: e.department_id?.name || null,
      manager_name: e.manager_id?.name || null,
      linked_user: e.user_id ? { id: e.user_id._id, name: e.user_id.name, email: e.user_id.email, role: e.user_id.role } : null,
      leave_balance: getLeaveBalances(e),
    };
  });
}

async function getEmployee(tenantId, id) {
  const e = await Employee.findOne({ _id: id, tenant_id: tenantId })
    .populate('department_id', 'name')
    .populate('manager_id', 'name employee_code')
    .populate('user_id', 'name email role');
  if (!e) throw httpError('Employee not found.', 404);
  const json = e.toJSON();
  return {
    ...json,
    id: json._id,
    department_name: e.department_id?.name || null,
    manager_name: e.manager_id?.name || null,
    linked_user: e.user_id ? { id: e.user_id._id, name: e.user_id.name, email: e.user_id.email, role: e.user_id.role } : null,
    leave_balance: getLeaveBalances(e),
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

async function approveLeaveRequest(tenantId, leaveId, reviewerId, status) {
  const leave = await LeaveRequest.findOne({ _id: leaveId, tenant_id: tenantId });
  if (!leave) throw httpError('Leave request not found.', 404);
  if (!['approved', 'rejected'].includes(status)) throw httpError('Invalid status.');

  if (status === 'approved' && leave.status === 'pending') {
    const emp = await Employee.findById(leave.employee_id);
    if (!emp) throw httpError('Employee not found.');
    const days = leaveDays(leave.start_date, leave.end_date);
    const type = (leave.leave_type || 'annual').toLowerCase();
    if (!emp.leave_balances) emp.leave_balances = { annual_used: 0, sick_used: 0 };

    if (type === 'sick') {
      const entitlement = emp.sick_leave_entitlement ?? DEFAULT_SICK_ENTITLEMENT;
      const used = emp.leave_balances.sick_used || 0;
      if (used + days > entitlement) {
        throw httpError(`Insufficient sick leave. ${entitlement - used} day(s) remaining.`);
      }
      emp.leave_balances.sick_used = used + days;
    } else if (type !== 'unpaid' && type !== 'other') {
      const entitlement = emp.annual_leave_entitlement ?? DEFAULT_ANNUAL_ENTITLEMENT;
      const used = emp.leave_balances.annual_used || 0;
      if (used + days > entitlement) {
        throw httpError(`Insufficient annual leave. ${entitlement - used} day(s) remaining.`);
      }
      emp.leave_balances.annual_used = used + days;
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
  const emp = await Employee.findOne({ _id: employee_id, tenant_id: tenantId, status: 'active' });
  if (!emp) throw httpError('Active employee not found.', 404);

  const existing = await PayrollRun.findOne({ tenant_id: tenantId, employee_id, month, year });
  if (existing) throw httpError('Payroll already exists for this employee and period.');

  const payrollSettings = settings || await getPayrollSettings(tenantId);
  const amounts = buildPayrollAmounts(
    emp.gross_salary,
    normalizePayLines(allowance_lines),
    normalizePayLines(deduction_lines),
    payrollSettings,
  );

  return PayrollRun.create({
    tenant_id: tenantId,
    branch_id: emp.branch_id || null,
    employee_id,
    month,
    year,
    status: 'submitted',
    ...amounts,
  });
}

async function runBulkPayroll(tenantId, { month, year, allowance_lines = [], deduction_lines = [] }) {
  const employees = await Employee.find({ tenant_id: tenantId, status: 'active' });
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

async function getHrSummary(tenantId, query = {}, branchFilter = {}) {
  const bf = branchFilter || {};
  const employees = await Employee.find({ tenant_id: tenantId, ...bf });
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [onLeave, pendingLeave, attendanceToday, payrollAgg] = await Promise.all([
    LeaveRequest.countDocuments({
      tenant_id: tenantId,
      ...bf,
      status: 'approved',
      start_date: { $lte: today },
      end_date: { $gte: today },
    }),
    LeaveRequest.countDocuments({ tenant_id: tenantId, ...bf, status: 'pending' }),
    Attendance.countDocuments({ tenant_id: tenantId, ...bf, date: today }),
    PayrollRun.aggregate([
      { $match: { tenant_id: tenantId, ...bf, status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$net_salary' }, runs: { $sum: 1 } } },
    ]),
  ]);

  return {
    total_employees: employees.length,
    active: employees.filter((e) => e.status === 'active').length,
    terminated: employees.filter((e) => e.status === 'terminated').length,
    on_leave: onLeave,
    pending_leave: pendingLeave,
    attendance_today: attendanceToday,
    payroll_total: payrollAgg[0]?.total || 0,
    payroll_runs: payrollAgg[0]?.runs || 0,
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

  const employees = await Employee.find({ tenant_id: tenantId, status: 'active', ...branchFilter });
  if (!employees.length) throw httpError('No active employees to run payroll for.');

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
      const amounts = buildPayrollAmounts(emp.gross_salary, sharedAllowances, sharedDeductions, payrollSettings);
      const run = await PayrollRun.create({
        tenant_id: tenantId, branch_id: emp.branch_id || null, employee_id: emp._id,
        month: m, year: y, status: 'submitted', batch_id: batch._id, ...amounts,
      });
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
  uploadEmployeeDocument,
  addEmployeeDocument,
  deleteEmployeeDocument,
  getLeaveBalances,
  getHrSummary,
  leaveDays,
};
