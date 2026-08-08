const { Employee, Project, ProjectTimeLog } = require('../models');
const labourService = require('../services/labourService');
const projectService = require('../services/projectService');
const audit = require('../utils/audit');

/**
 * Labour allocation.
 *
 * Splitting attended days across the jobs they were spent on, so wages that
 * have been paid stop being invisible to the projects that consumed them.
 */

const scope = (req) => ({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) });

/** Days attended in a window, with what has been allocated against each. */
const board = async (req, res) => {
  const { from, to, employee_id, unallocated_only } = req.query;
  const data = await labourService.getBoard(req.tenant_id, {
    from, to,
    employeeId: employee_id || undefined,
    branchFilter: req.branchFilter || {},
    unallocatedOnly: unallocated_only === 'true',
  });
  res.json({ success: true, data });
};

/**
 * Write one person's day.
 *
 * The whole day is replaced rather than appended to, because the ceiling — you
 * cannot book more hours than were worked — only holds if the day is checked as
 * a unit.
 */
const allocate = async (req, res) => {
  const { employee_id, work_date, allocations } = req.body;
  if (!employee_id || !work_date) {
    return res.status(400).json({ success: false, message: 'An employee and a date are required.' });
  }
  if (!Array.isArray(allocations)) {
    return res.status(400).json({ success: false, message: 'Send the day\'s allocations as a list.' });
  }

  // Branch scope is enforced on the employee, not the projects — someone can
  // legitimately spend a day on a job run out of another branch, but they must
  // be a person this caller is entitled to see.
  const employee = await Employee.findOne({ _id: employee_id, ...scope(req) }).select('_id name').lean();
  if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });

  const result = await labourService.allocateDay(req.tenant_id, {
    employeeId: employee_id,
    workDate: work_date,
    allocations,
    userId: req.user._id,
  });
  if (result.error) return res.status(400).json({ success: false, message: result.error });

  // Labour is part of a project's actual cost, so anything the day touched has
  // to be re-read rather than left showing yesterday's figure.
  await Promise.all(result.touched_projects.map((id) =>
    projectService.recalculate(id, req.tenant_id).catch(() => {})));

  res.json({ success: true, data: result });
  await audit(req, 'ALLOCATE_LABOUR', 'projects',
    `${req.user.name} allocated ${result.allocated_hours}h of ${employee.name}'s time on ${new Date(work_date).toDateString()}`,
    { employee: employee.name, hours: result.allocated_hours, cost: result.cost });
};

/**
 * Labour cost by project over a window.
 *
 * The counterpart to the board: the board shows whose time is unaccounted for,
 * this shows where the accounted-for time went.
 */
const byProject = async (req, res) => {
  const { from, to } = req.query;
  const match = { tenant_id: req.tenant_id };
  if (from || to) {
    match.work_date = {};
    if (from) match.work_date.$gte = labourService.dayKey(from);
    if (to) match.work_date.$lte = labourService.dayKey(to);
  }

  const rows = await ProjectTimeLog.aggregate([
    { $match: match },
    { $group: {
      _id: '$project_id',
      hours: { $sum: '$hours' },
      cost: { $sum: '$cost' },
      days: { $addToSet: { e: '$employee_id', d: '$work_date' } },
      people: { $addToSet: '$employee_id' },
    } },
    { $sort: { cost: -1 } },
    { $limit: 200 },
  ]);

  const projects = await Project.find({ _id: { $in: rows.map((r) => r._id) }, ...scope(req) })
    .select('code name status').lean();
  const byId = new Map(projects.map((p) => [String(p._id), p]));

  res.json({
    success: true,
    data: rows
      // A project outside the caller's branch scope drops out rather than
      // appearing as an unnamed row.
      .filter((r) => byId.has(String(r._id)))
      .map((r) => {
        const p = byId.get(String(r._id));
        return {
          project_id: String(r._id),
          code: p.code,
          name: p.name,
          status: p.status,
          hours: projectService.round2(r.hours),
          cost: projectService.round2(r.cost),
          people: r.people.length,
          days: r.days.length,
        };
      }),
  });
};

module.exports = { board, allocate, byProject };
