const { Tenant, Employee, Attendance, ProjectTimeLog, Project } = require('../models');
const projectService = require('./projectService');

/**
 * Labour — turning attendance into project cost.
 *
 * Attendance records that someone was here and for how long. It does not record
 * what they worked on, and a project has no way to infer it. So wages are real,
 * paid, and invisible to the job that consumed them: margin reads high, cost to
 * complete extrapolates from a number that is too small, and the cash forecast
 * understates what has to go out.
 *
 * The gap is closed by splitting each attended day across the projects it was
 * spent on. What makes that trustworthy is the ceiling: a day can never be
 * allocated for more hours than the person was actually present, so project
 * cost can be incomplete but never invented.
 *
 * Whatever is left over is the honest measure of how much of the wage bill is
 * still unattributed, and it is reported rather than hidden.
 */

const { round2 } = projectService;

const MS_DAY = 86400000;

/** Midnight UTC, so a day compares equal however it was entered. */
function dayKey(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}
const keyOf = (employeeId, date) => `${String(employeeId)}|${dayKey(date).toISOString()}`;

/**
 * What an hour of someone's time costs.
 *
 * A rate set on the employee wins outright — day labour and subcontracted
 * trades are paid by the hour or the day, and dividing a monthly salary they
 * never had would be nonsense. Otherwise it comes from the monthly figure over
 * the tenant's working month.
 */
function resolveHourlyRate(employee, settings) {
  if (employee.hourly_rate > 0) {
    return { rate: round2(employee.hourly_rate), basis: 'override' };
  }
  const days = settings.working_days_per_month > 0 ? settings.working_days_per_month : 26;
  const hours = settings.standard_hours_per_day > 0 ? settings.standard_hours_per_day : 8;
  const monthly = employee.gross_salary || 0;
  if (monthly <= 0) return { rate: 0, basis: 'unknown' };
  return { rate: round2(monthly / (days * hours)), basis: 'derived' };
}

/**
 * The cost of one hour of a particular day.
 *
 * Overtime is paid at a premium, so a day carrying some of it costs more per
 * hour than the base rate. Rather than splitting every allocation into normal
 * and overtime portions — which would force whoever is allocating to decide
 * which project got the expensive hours, a question they cannot answer — the
 * day's total cost is spread evenly across its hours. Each project then bears
 * its share of the premium in proportion to the time it took.
 */
function blendedRate(attendance, rate, multiplier) {
  const total = attendance.hours_worked || 0;
  if (total <= 0 || rate <= 0) return 0;
  const overtime = Math.min(Math.max(attendance.overtime_hours || 0, 0), total);
  const regular = total - overtime;
  const dayCost = regular * rate + overtime * rate * multiplier;
  return round2(dayCost / total);
}

async function getSettings(tenantId) {
  const tenant = await Tenant.findById(tenantId).select('attendance_settings').lean();
  const s = tenant?.attendance_settings || {};
  return {
    standard_hours_per_day: s.standard_hours_per_day > 0 ? s.standard_hours_per_day : 8,
    working_days_per_month: s.working_days_per_month > 0 ? s.working_days_per_month : 26,
    overtime_multiplier: s.overtime_multiplier > 0 ? s.overtime_multiplier : 1.5,
  };
}

/**
 * Every attended day in a window, with what has been allocated against it.
 *
 * Days off, leave and holidays are left out — there are no hours to attribute,
 * and listing them would bury the days that do need attention.
 */
async function getBoard(tenantId, { from, to, employeeId, branchFilter = {}, unallocatedOnly } = {}) {
  const settings = await getSettings(tenantId);

  const range = {};
  if (from) range.$gte = dayKey(from);
  if (to) range.$lte = dayKey(to);

  const attendanceFilter = {
    tenant_id: tenantId,
    ...branchFilter,
    status: { $in: ['present', 'half_day'] },
    hours_worked: { $gt: 0 },
    ...(Object.keys(range).length ? { date: range } : {}),
    ...(employeeId ? { employee_id: employeeId } : {}),
  };

  const attendance = await Attendance.find(attendanceFilter).sort({ date: -1 }).limit(1000).lean();
  if (!attendance.length) {
    return { settings, rows: [], summary: emptySummary() };
  }

  const employeeIds = [...new Set(attendance.map((a) => String(a.employee_id)))];
  const [employees, logs] = await Promise.all([
    Employee.find({ _id: { $in: employeeIds }, tenant_id: tenantId })
      .select('name employee_code gross_salary hourly_rate job_title').lean(),
    ProjectTimeLog.find({
      tenant_id: tenantId,
      employee_id: { $in: employeeIds },
      ...(Object.keys(range).length ? { work_date: range } : {}),
    }).populate('project_id', 'code name').lean(),
  ]);

  const employeeById = new Map(employees.map((e) => [String(e._id), e]));

  const logsByDay = new Map();
  for (const l of logs) {
    const k = keyOf(l.employee_id, l.work_date);
    if (!logsByDay.has(k)) logsByDay.set(k, []);
    logsByDay.get(k).push(l);
  }

  const rows = attendance.map((a) => {
    const employee = employeeById.get(String(a.employee_id));
    const { rate, basis } = employee
      ? resolveHourlyRate(employee, settings)
      : { rate: 0, basis: 'unknown' };
    const hourly = blendedRate(a, rate, settings.overtime_multiplier);

    const dayLogs = logsByDay.get(keyOf(a.employee_id, a.date)) || [];
    const allocated = round2(dayLogs.reduce((s, l) => s + (l.hours || 0), 0));
    // Time booked straight onto a project by someone who knew what was worked
    // on. It holds its ground — an allocation can only spend what it leaves.
    const manualHours = round2(dayLogs.filter((l) => l.source !== 'attendance')
      .reduce((s, l) => s + (l.hours || 0), 0));
    const attended = round2(a.hours_worked || 0);

    return {
      attendance_id: String(a._id),
      employee_id: String(a.employee_id),
      employee_name: employee?.name || 'Unknown',
      employee_code: employee?.employee_code || '',
      job_title: employee?.job_title || '',
      date: a.date,
      status: a.status,
      attended_hours: attended,
      overtime_hours: round2(a.overtime_hours || 0),
      hourly_rate: hourly,
      rate_basis: basis,
      day_cost: round2(attended * hourly),
      allocated_hours: allocated,
      manual_hours: manualHours,
      unallocated_hours: round2(Math.max(attended - allocated, 0)),
      // What can still be spread from this day.
      allocatable_hours: round2(Math.max(attended - manualHours, 0)),
      allocated_cost: round2(dayLogs.reduce((s, l) => s + (l.cost || 0), 0)),
      unattributed_cost: round2(Math.max(attended - allocated, 0) * hourly),
      allocations: dayLogs.map((l) => ({
        id: String(l._id),
        project_id: l.project_id ? String(l.project_id._id || l.project_id) : null,
        project_code: l.project_id?.code || null,
        project_name: l.project_id?.name || null,
        hours: round2(l.hours || 0),
        cost: round2(l.cost || 0),
        source: l.source || 'manual',
        notes: l.notes || '',
      })),
    };
  });

  const visible = unallocatedOnly ? rows.filter((r) => r.unallocated_hours > 0) : rows;
  return { settings, rows: visible, summary: summarise(rows) };
}

function emptySummary() {
  return {
    days: 0, employees: 0,
    attended_hours: 0, allocated_hours: 0, unallocated_hours: 0,
    wage_cost: 0, allocated_cost: 0, unattributed_cost: 0,
    allocated_pct: 0, days_with_gap: 0, missing_rate_employees: 0,
  };
}

/**
 * The figure that matters is unattributed cost: wages that have been paid and
 * that no job is carrying. While it is large, every margin on the system is
 * flattering and every cost forecast built from a run rate is low.
 */
function summarise(rows) {
  if (!rows.length) return emptySummary();

  const attended = round2(rows.reduce((s, r) => s + r.attended_hours, 0));
  const allocated = round2(rows.reduce((s, r) => s + Math.min(r.allocated_hours, r.attended_hours), 0));
  const wage = round2(rows.reduce((s, r) => s + r.day_cost, 0));
  const allocatedCost = round2(rows.reduce((s, r) => s + r.allocated_cost, 0));

  return {
    days: rows.length,
    employees: new Set(rows.map((r) => r.employee_id)).size,
    attended_hours: attended,
    allocated_hours: allocated,
    unallocated_hours: round2(Math.max(attended - allocated, 0)),
    wage_cost: wage,
    allocated_cost: allocatedCost,
    unattributed_cost: round2(Math.max(wage - allocatedCost, 0)),
    allocated_pct: attended > 0 ? round2((allocated / attended) * 100) : 0,
    days_with_gap: rows.filter((r) => r.unallocated_hours > 0).length,
    // Nobody can cost these people's time until a salary or rate is recorded.
    missing_rate_employees: new Set(rows.filter((r) => r.hourly_rate <= 0).map((r) => r.employee_id)).size,
  };
}

/**
 * Replace one person's allocations for one day.
 *
 * Written as a whole day rather than row by row because the ceiling only means
 * anything if the day is validated as a unit — checking each row on its own
 * lets three legitimate bookings add up to fourteen hours of an eight hour day.
 */
async function allocateDay(tenantId, { employeeId, workDate, allocations, userId }) {
  const settings = await getSettings(tenantId);
  const day = dayKey(workDate);

  const [employee, attendance] = await Promise.all([
    Employee.findOne({ _id: employeeId, tenant_id: tenantId }).lean(),
    Attendance.findOne({ employee_id: employeeId, tenant_id: tenantId, date: day }).lean(),
  ]);

  if (!employee) return { error: 'Employee not found.' };
  if (!attendance || !(attendance.hours_worked > 0)) {
    return { error: 'No attendance is recorded for that person on that day, so there are no hours to allocate.' };
  }

  const { rate, basis } = resolveHourlyRate(employee, settings);
  const hourly = blendedRate(attendance, rate, settings.overtime_multiplier);

  const existing = await ProjectTimeLog.find({
    tenant_id: tenantId, employee_id: employeeId, work_date: day,
  }).lean();
  const manualHours = round2(existing.filter((l) => l.source !== 'attendance')
    .reduce((s, l) => s + (l.hours || 0), 0));

  const attended = round2(attendance.hours_worked);
  const allocatable = round2(Math.max(attended - manualHours, 0));

  const clean = [];
  for (const a of allocations || []) {
    const hours = Number(a.hours);
    if (!Number.isFinite(hours) || hours <= 0) continue;
    if (!a.project_id) return { error: 'Every line needs a project.' };
    clean.push({ project_id: a.project_id, task_id: a.task_id || null, hours: round2(hours), notes: a.notes });
  }

  const total = round2(clean.reduce((s, a) => s + a.hours, 0));
  if (total > allocatable) {
    return {
      error: manualHours > 0
        ? `Only ${allocatable} of the ${attended} hours worked are left — ${manualHours} are already booked directly against a project.`
        : `${total} hours cannot be allocated from a ${attended} hour day.`,
    };
  }

  // Every project has to belong to the tenant. Checked in one query rather than
  // per line so a long day doesn't fan out into a query each.
  const projectIds = [...new Set(clean.map((a) => String(a.project_id)))];
  if (projectIds.length) {
    const found = await Project.countDocuments({ _id: { $in: projectIds }, tenant_id: tenantId });
    if (found !== projectIds.length) return { error: 'One or more projects could not be found.' };
  }

  // The day is rewritten, so previous allocations for it go first. Manual
  // bookings are left alone — they were made by someone who knew better.
  await ProjectTimeLog.deleteMany({
    tenant_id: tenantId, employee_id: employeeId, work_date: day, source: 'attendance',
  });

  const created = clean.length
    ? await ProjectTimeLog.insertMany(clean.map((a) => ({
      tenant_id: tenantId,
      project_id: a.project_id,
      task_id: a.task_id,
      employee_id: employeeId,
      work_date: day,
      hours: a.hours,
      hourly_rate: hourly,
      cost: round2(a.hours * hourly),
      source: 'attendance',
      attendance_id: attendance._id,
      notes: a.notes,
      created_by: userId || null,
    })))
    : [];

  // Every project the day touched, before and after, needs its cost re-read —
  // including any it was just taken off, which would otherwise keep carrying
  // labour it no longer has. Reads through a populated reference as well as a
  // raw one, so this cannot silently start producing "[object Object]" if the
  // query above ever gains a populate.
  const idOf = (ref) => (ref && typeof ref === 'object' ? String(ref._id ?? ref) : String(ref));
  const touched = [...new Set([
    ...existing.filter((l) => l.source === 'attendance' && l.project_id).map((l) => idOf(l.project_id)),
    ...projectIds,
  ])];

  return {
    allocated_hours: total,
    unallocated_hours: round2(Math.max(attended - manualHours - total, 0)),
    hourly_rate: hourly,
    rate_basis: basis,
    cost: round2(total * hourly),
    logs: created,
    touched_projects: touched,
  };
}

module.exports = {
  resolveHourlyRate,
  blendedRate,
  getSettings,
  getBoard,
  allocateDay,
  summarise,
  dayKey,
  MS_DAY,
};
