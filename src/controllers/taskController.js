const { WorkTask, Employee } = require('../models');
const audit = require('../utils/audit');

// Roles that may hand work to anyone in their scope. Anyone else may assign
// only to the employees who report to them (Employee.manager_id).
const ASSIGNER_ROLES = ['platform_admin', 'business_owner', 'branch_manager', 'hr_manager'];
const isAssigner = (req) => ASSIGNER_ROLES.includes(req.user.role);

const withId = (d) => (d ? { ...d, id: String(d._id) } : d);
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

/** 'YYYY-MM-DD' -> midnight UTC of that day, or null when it isn't a date. */
function parseDay(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(str)) return null;
  const d = new Date(`${str.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const todayUtc = () => parseDay(new Date().toISOString().slice(0, 10));

async function myEmployee(req) {
  if (req._emp === undefined) {
    req._emp = await Employee.findOne({ tenant_id: req.tenant_id, user_id: req.user._id }).select('_id name').lean();
  }
  return req._emp;
}

/** Employees this caller may assign work to. */
async function assignableEmployees(req) {
  const base = { tenant_id: req.tenant_id, status: { $ne: 'terminated' } };
  if (isAssigner(req)) {
    return Employee.find({ ...base, ...(req.branchFilter || {}) }).select('name job_title branch_id').sort('name').lean();
  }
  const me = await myEmployee(req);
  if (!me) return [];
  return Employee.find({ ...base, manager_id: me._id }).select('name job_title branch_id').sort('name').lean();
}

const listAssignable = async (req, res) => {
  const data = await assignableEmployees(req);
  res.json({ success: true, data: data.map(withId) });
};

// What is on the caller's plate: the day asked for (default today), and — when
// looking at today — anything earlier they never finished.
const listMine = async (req, res) => {
  const me = await myEmployee(req);
  if (!me) return res.json({ success: true, data: [], linked: false });
  const day = parseDay(req.query.date) || todayUtc();
  const isToday = day.getTime() === todayUtc().getTime();

  const or = [{ due_date: { $gte: day, $lt: addDays(day, 1) } }];
  if (isToday) or.push({ due_date: { $lt: day }, status: { $ne: 'done' } });

  const tasks = await WorkTask.find({ tenant_id: req.tenant_id, assignee_id: me._id, $or: or }).lean();
  const data = tasks
    .map((t) => ({ ...withId(t), overdue: t.status !== 'done' && t.due_date < day }))
    .sort((a, b) => (a.status === 'done') - (b.status === 'done')
      || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
      || a.due_date - b.due_date);
  res.json({ success: true, data, linked: true });
};

// Tasks the caller handed out (or, for managers, everything in scope).
const listAssigned = async (req, res) => {
  const filter = { tenant_id: req.tenant_id };
  if (isAssigner(req)) {
    Object.assign(filter, req.branchFilter || {});
  } else {
    const team = await assignableEmployees(req);
    if (!team.length) return res.json({ success: true, data: [], summary: [] });
    filter.assignee_id = { $in: team.map((e) => e._id) };
  }
  if (req.query.assignee_id) {
    if (filter.assignee_id) {
      const allowed = filter.assignee_id.$in.some((id) => String(id) === req.query.assignee_id);
      if (!allowed) return res.json({ success: true, data: [], summary: [] });
    }
    filter.assignee_id = req.query.assignee_id;
  }
  if (['todo', 'in_progress', 'done'].includes(req.query.status)) filter.status = req.query.status;
  const from = parseDay(req.query.from), to = parseDay(req.query.to);
  if (from || to) filter.due_date = { ...(from && { $gte: from }), ...(to && { $lt: addDays(to, 1) }) };

  const tasks = await WorkTask.find(filter).populate('assignee_id', 'name job_title')
    .sort({ due_date: -1, createdAt: -1 }).limit(1000).lean();

  const today = todayUtc();
  const data = tasks.map((t) => ({
    ...withId(t),
    assignee_id: t.assignee_id?._id,
    assignee_name: t.assignee_id?.name || '—',
    overdue: t.status !== 'done' && t.due_date < today,
  }));

  // Per-person tally, for the owner's at-a-glance view.
  const byPerson = new Map();
  for (const t of data) {
    const key = String(t.assignee_id);
    const row = byPerson.get(key) || { assignee_id: key, assignee_name: t.assignee_name, total: 0, done: 0, overdue: 0 };
    row.total++; if (t.status === 'done') row.done++; if (t.overdue) row.overdue++;
    byPerson.set(key, row);
  }
  res.json({ success: true, data, summary: [...byPerson.values()].sort((a, b) => a.assignee_name.localeCompare(b.assignee_name)) });
};

const createTasks = async (req, res) => {
  const { title, description, priority } = req.body;
  const ids = [].concat(req.body.assignee_ids || req.body.assignee_id || []).map(String);
  const due = parseDay(req.body.due_date);
  if (!String(title || '').trim()) return res.status(400).json({ success: false, message: 'A title is required.' });
  if (!due) return res.status(400).json({ success: false, message: 'A due date is required.' });
  if (!ids.length) return res.status(400).json({ success: false, message: 'Choose at least one employee.' });

  const allowed = new Map((await assignableEmployees(req)).map((e) => [String(e._id), e]));
  const bad = ids.filter((id) => !allowed.has(id));
  if (bad.length) return res.status(403).json({ success: false, message: 'You can only assign tasks to employees who report to you.' });

  const docs = await WorkTask.insertMany([...new Set(ids)].map((id) => ({
    tenant_id: req.tenant_id,
    branch_id: allowed.get(id).branch_id || undefined,
    title: String(title).trim(),
    description: String(description || '').trim(),
    assignee_id: id,
    assigned_by: req.user._id,
    assigned_by_name: req.user.name,
    due_date: due,
    priority: ['low', 'normal', 'high'].includes(priority) ? priority : 'normal',
  })));
  res.status(201).json({ success: true, data: docs });
  await audit(req, 'ASSIGN_TASK', 'tasks', `${req.user.name} assigned "${String(title).trim()}" to ${docs.length} employee(s)`, { count: docs.length });
};

/** Load a task the caller may act on: its assignee, or someone who may assign to the assignee. */
async function loadTask(req, { assigneeMayAct }) {
  const task = await WorkTask.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!task) return { task: null };
  const me = await myEmployee(req);
  if (assigneeMayAct && me && String(me._id) === String(task.assignee_id)) return { task };
  const team = await assignableEmployees(req);
  if (team.some((e) => String(e._id) === String(task.assignee_id))) return { task };
  return { task, forbidden: true };
}

const setStatus = async (req, res) => {
  const { status, note } = req.body;
  if (!['todo', 'in_progress', 'done'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
  const { task, forbidden } = await loadTask(req, { assigneeMayAct: true });
  if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
  if (forbidden) return res.status(403).json({ success: false, message: 'Access denied.' });

  task.status = status;
  task.completed_at = status === 'done' ? new Date() : undefined;
  if (note !== undefined) task.completion_note = String(note).trim();
  await task.save();
  res.json({ success: true, data: task });
};

const updateTask = async (req, res) => {
  const { task, forbidden } = await loadTask(req, { assigneeMayAct: false });
  if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
  if (forbidden) return res.status(403).json({ success: false, message: 'Access denied.' });
  for (const k of ['title', 'description']) if (req.body[k] !== undefined) task[k] = String(req.body[k]).trim();
  if (!task.title) return res.status(400).json({ success: false, message: 'A title is required.' });
  if (['low', 'normal', 'high'].includes(req.body.priority)) task.priority = req.body.priority;
  if (req.body.due_date !== undefined) {
    const due = parseDay(req.body.due_date);
    if (!due) return res.status(400).json({ success: false, message: 'Invalid due date.' });
    task.due_date = due;
  }
  await task.save();
  res.json({ success: true, data: task });
};

const removeTask = async (req, res) => {
  const { task, forbidden } = await loadTask(req, { assigneeMayAct: false });
  if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
  if (forbidden) return res.status(403).json({ success: false, message: 'Access denied.' });
  await task.deleteOne();
  res.json({ success: true });
};

module.exports = { listAssignable, listMine, listAssigned, createTasks, setStatus, updateTask, removeTask };
