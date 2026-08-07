const {
  Project, ProjectMilestone, ProjectTask, ProjectVariation, ProjectTimeLog,
  Customer, Employee, Expense, PurchaseOrder, Invoice,
} = require('../models');
const { resolveWriteBranchId } = require('../middleware/branchScope');
const projectService = require('../services/projectService');
const audit = require('../utils/audit');

const scope = (req) => ({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) });

/** Load a project within the caller's tenant and branch scope, or null. */
async function findScoped(req) {
  return Project.findOne({ _id: req.params.id, ...scope(req) });
}

/* ── Projects ─────────────────────────────────────────────────────────────── */

const list = async (req, res) => {
  const { status, search } = req.query;
  const filter = scope(req);
  if (status) filter.status = status;
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { code: new RegExp(search, 'i') }, { customer_name: new RegExp(search, 'i') }];

  const projects = await Project.find(filter)
    .populate('manager_id', 'first_name last_name')
    .sort({ createdAt: -1 })
    .lean();

  // Overdue is worth seeing in the list rather than only on the detail page.
  const now = Date.now();
  res.json({
    success: true,
    data: projects.map((p) => ({
      ...p,
      is_overdue: !!p.planned_end_date
        && !['completed', 'cancelled'].includes(p.status)
        && new Date(p.planned_end_date).getTime() < now,
    })),
  });
};

const get = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

  const [milestones, tasks, variations, financials] = await Promise.all([
    ProjectMilestone.find({ project_id: project._id, tenant_id: req.tenant_id }).sort({ sequence: 1, createdAt: 1 }).lean(),
    ProjectTask.find({ project_id: project._id, tenant_id: req.tenant_id }).populate('assignee_id', 'first_name last_name').sort({ createdAt: 1 }).lean(),
    ProjectVariation.find({ project_id: project._id, tenant_id: req.tenant_id }).sort({ createdAt: -1 }).lean(),
    projectService.getFinancials(project._id, req.tenant_id),
  ]);

  res.json({ success: true, data: { project, milestones, tasks, variations, financials } });
};

const create = async (req, res) => {
  const {
    name, description, customer_id, contract_value, currency, budget_lines,
    retention_pct, start_date, planned_end_date, manager_id, team, site_address, status,
  } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'A project name is required.' });

  let customerName = '';
  if (customer_id) {
    const customer = await Customer.findOne({ _id: customer_id, tenant_id: req.tenant_id }).select('name').lean();
    if (!customer) return res.status(404).json({ success: false, message: 'Client not found.' });
    customerName = customer.name;
  }

  const project = await Project.create({
    tenant_id: req.tenant_id,
    branch_id: await resolveWriteBranchId(req),
    code: await projectService.nextCode(req.tenant_id),
    name,
    description,
    customer_id: customer_id || null,
    customer_name: customerName,
    contract_value: Number(contract_value) || 0,
    currency: currency || 'GHS',
    budget_lines: Array.isArray(budget_lines) ? budget_lines : [],
    retention_pct: Number(retention_pct) || 0,
    start_date: start_date || null,
    planned_end_date: planned_end_date || null,
    manager_id: manager_id || null,
    team: Array.isArray(team) ? team : [],
    site_address,
    status: status || 'draft',
    created_by: req.user._id,
  });

  res.status(201).json({ success: true, data: project });
  await audit(req, 'CREATE_PROJECT', 'projects', `${req.user.name} created project ${project.code} — ${project.name}`, { code: project.code, contract_value: project.contract_value });
};

const update = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

  const fields = [
    'name', 'description', 'contract_value', 'currency', 'budget_lines', 'retention_pct',
    'start_date', 'planned_end_date', 'actual_end_date', 'manager_id', 'team', 'site_address', 'status',
  ];
  for (const f of fields) if (req.body[f] !== undefined) project[f] = req.body[f];

  if (req.body.customer_id !== undefined) {
    if (req.body.customer_id) {
      const customer = await Customer.findOne({ _id: req.body.customer_id, tenant_id: req.tenant_id }).select('name').lean();
      if (!customer) return res.status(404).json({ success: false, message: 'Client not found.' });
      project.customer_id = customer._id;
      project.customer_name = customer.name;
    } else {
      project.customer_id = null;
      project.customer_name = '';
    }
  }

  // Completing a job stamps the finish date if nobody set one.
  if (req.body.status === 'completed' && !project.actual_end_date) project.actual_end_date = new Date();

  await project.save();
  res.json({ success: true, data: project });
  await audit(req, 'UPDATE_PROJECT', 'projects', `${req.user.name} updated project ${project.code}`, { code: project.code });
};

/**
 * Removing a project takes its milestones, tasks, variations and time with it,
 * but deliberately leaves expenses, purchase orders and invoices alone — those
 * are accounting records and must not vanish because a project was tidied up.
 * They are simply untagged.
 */
const remove = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

  const filter = { project_id: project._id, tenant_id: req.tenant_id };
  await Promise.all([
    ProjectMilestone.deleteMany(filter),
    ProjectTask.deleteMany(filter),
    ProjectVariation.deleteMany(filter),
    ProjectTimeLog.deleteMany(filter),
    Expense.updateMany(filter, { $unset: { project_id: '' } }),
    PurchaseOrder.updateMany(filter, { $unset: { project_id: '' } }),
  ]);
  await project.deleteOne();

  res.json({ success: true });
  await audit(req, 'DELETE_PROJECT', 'projects', `${req.user.name} deleted project ${project.code}`, { code: project.code });
};

const financials = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  res.json({ success: true, data: await projectService.getFinancials(project._id, req.tenant_id) });
};

/* ── Milestones ───────────────────────────────────────────────────────────── */

const addMilestone = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const { name, description, weight, sequence, planned_start, planned_end, billable_amount } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'A milestone name is required.' });

  const milestone = await ProjectMilestone.create({
    tenant_id: req.tenant_id,
    project_id: project._id,
    name, description,
    weight: weight !== undefined ? Number(weight) : 1,
    sequence: sequence !== undefined ? Number(sequence) : await ProjectMilestone.countDocuments({ project_id: project._id }),
    planned_start: planned_start || null,
    planned_end: planned_end || null,
    billable_amount: Number(billable_amount) || 0,
  });

  await projectService.recalculate(project._id, req.tenant_id);
  res.status(201).json({ success: true, data: milestone });
};

const updateMilestone = async (req, res) => {
  const milestone = await ProjectMilestone.findOne({ _id: req.params.milestoneId, tenant_id: req.tenant_id });
  if (!milestone) return res.status(404).json({ success: false, message: 'Milestone not found.' });

  for (const f of ['name', 'description', 'weight', 'sequence', 'planned_start', 'planned_end', 'billable_amount', 'progress_pct', 'status']) {
    if (req.body[f] !== undefined) milestone[f] = req.body[f];
  }
  if (req.body.status === 'completed') {
    milestone.progress_pct = 100;
    milestone.actual_end ||= new Date();
  }
  if (req.body.status === 'in_progress') milestone.actual_start ||= new Date();

  await milestone.save();
  const progress = await projectService.recalculate(milestone.project_id, req.tenant_id);
  res.json({ success: true, data: milestone, project_progress: progress });
};

const removeMilestone = async (req, res) => {
  const milestone = await ProjectMilestone.findOne({ _id: req.params.milestoneId, tenant_id: req.tenant_id });
  if (!milestone) return res.status(404).json({ success: false, message: 'Milestone not found.' });
  // Tasks outlive their milestone rather than being destroyed with it; they
  // simply stop counting toward a stage.
  await ProjectTask.updateMany({ milestone_id: milestone._id, tenant_id: req.tenant_id }, { $unset: { milestone_id: '' } });
  await milestone.deleteOne();
  const progress = await projectService.recalculate(milestone.project_id, req.tenant_id);
  res.json({ success: true, project_progress: progress });
};

/* ── Tasks ────────────────────────────────────────────────────────────────── */

const addTask = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const { name, description, milestone_id, weight, assignee_id, due_date, status } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'A task name is required.' });

  const task = await ProjectTask.create({
    tenant_id: req.tenant_id,
    project_id: project._id,
    milestone_id: milestone_id || null,
    name, description,
    weight: weight !== undefined ? Number(weight) : 1,
    assignee_id: assignee_id || null,
    due_date: due_date || null,
    status: status || 'todo',
    created_by: req.user._id,
  });

  const progress = await projectService.recalculate(project._id, req.tenant_id);
  res.status(201).json({ success: true, data: task, project_progress: progress });
};

const updateTask = async (req, res) => {
  const task = await ProjectTask.findOne({ _id: req.params.taskId, tenant_id: req.tenant_id });
  if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

  for (const f of ['name', 'description', 'milestone_id', 'weight', 'assignee_id', 'due_date', 'status']) {
    if (req.body[f] !== undefined) task[f] = req.body[f];
  }
  task.completed_at = task.status === 'done' ? (task.completed_at || new Date()) : null;

  await task.save();
  const progress = await projectService.recalculate(task.project_id, req.tenant_id);
  res.json({ success: true, data: task, project_progress: progress });
};

const removeTask = async (req, res) => {
  const task = await ProjectTask.findOne({ _id: req.params.taskId, tenant_id: req.tenant_id });
  if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
  await task.deleteOne();
  const progress = await projectService.recalculate(task.project_id, req.tenant_id);
  res.json({ success: true, project_progress: progress });
};

/* ── Variations ───────────────────────────────────────────────────────────── */

const addVariation = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const { reference, description, amount, raised_on } = req.body;
  if (!description || amount === undefined) {
    return res.status(400).json({ success: false, message: 'A description and amount are required.' });
  }
  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0) {
    return res.status(400).json({ success: false, message: 'Enter an amount — negative for an omission.' });
  }

  const count = await ProjectVariation.countDocuments({ project_id: project._id, tenant_id: req.tenant_id });
  const variation = await ProjectVariation.create({
    tenant_id: req.tenant_id,
    project_id: project._id,
    reference: reference?.trim() || `VO-${String(count + 1).padStart(3, '0')}`,
    description,
    amount: value,
    raised_on: raised_on || new Date(),
    created_by: req.user._id,
  });

  res.status(201).json({ success: true, data: variation });
};

/**
 * Approve or reject a variation. Only approved ones move the contract sum, so
 * a pending claim never inflates the figure the business is working to.
 */
const decideVariation = async (req, res) => {
  const { decision } = req.body;
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ success: false, message: 'Decision must be approved or rejected.' });
  }
  const variation = await ProjectVariation.findOne({ _id: req.params.variationId, tenant_id: req.tenant_id });
  if (!variation) return res.status(404).json({ success: false, message: 'Variation not found.' });

  variation.status = decision;
  variation.decided_on = new Date();
  variation.decided_by = req.user._id;
  await variation.save();

  res.json({ success: true, data: variation });
  await audit(req, 'DECIDE_VARIATION', 'projects', `${req.user.name} ${decision} variation ${variation.reference}`, { reference: variation.reference, amount: variation.amount });
};

const removeVariation = async (req, res) => {
  const variation = await ProjectVariation.findOne({ _id: req.params.variationId, tenant_id: req.tenant_id });
  if (!variation) return res.status(404).json({ success: false, message: 'Variation not found.' });
  await variation.deleteOne();
  res.json({ success: true });
};

/* ── Time ─────────────────────────────────────────────────────────────────── */

const listTime = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const logs = await ProjectTimeLog.find({ project_id: project._id, tenant_id: req.tenant_id })
    .populate('employee_id', 'first_name last_name')
    .sort({ work_date: -1 })
    .limit(200)
    .lean();
  res.json({ success: true, data: logs });
};

const logTime = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const { employee_id, work_date, hours, hourly_rate, task_id, notes } = req.body;

  if (!employee_id || !work_date || hours === undefined) {
    return res.status(400).json({ success: false, message: 'Employee, date and hours are required.' });
  }
  const worked = Number(hours);
  if (!Number.isFinite(worked) || worked <= 0 || worked > 24) {
    return res.status(400).json({ success: false, message: 'Hours must be between 0 and 24.' });
  }

  const employee = await Employee.findOne({ _id: employee_id, tenant_id: req.tenant_id }).lean();
  if (!employee) return res.status(404).json({ success: false, message: 'Employee not found.' });

  // Rate is snapshotted so historic cost doesn't shift when pay is revised.
  const rate = hourly_rate !== undefined ? Number(hourly_rate) : 0;
  const log = await ProjectTimeLog.create({
    tenant_id: req.tenant_id,
    project_id: project._id,
    task_id: task_id || null,
    employee_id,
    work_date,
    hours: worked,
    hourly_rate: rate,
    cost: projectService.round2(worked * rate),
    notes,
    created_by: req.user._id,
  });

  res.status(201).json({ success: true, data: log });
};

const removeTime = async (req, res) => {
  const log = await ProjectTimeLog.findOne({ _id: req.params.logId, tenant_id: req.tenant_id });
  if (!log) return res.status(404).json({ success: false, message: 'Time entry not found.' });
  await log.deleteOne();
  res.json({ success: true });
};

/* ── Progress billing ─────────────────────────────────────────────────────── */

const billing = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

  const [position, invoices, billable] = await Promise.all([
    projectService.getBillingPosition(project._id, req.tenant_id),
    Invoice.find({ project_id: project._id, tenant_id: req.tenant_id })
      .select('invoice_number issue_date due_date work_value retention_amount total amount_paid status is_retention_release')
      .sort({ createdAt: -1 })
      .lean(),
    // Completed stages carrying a value that haven't been put on an
    // application yet.
    ProjectMilestone.find({
      project_id: project._id,
      tenant_id: req.tenant_id,
      status: 'completed',
      billable_amount: { $gt: 0 },
      billed_invoice_id: { $in: [null, undefined] },
    }).select('name billable_amount actual_end').sort({ sequence: 1 }).lean(),
  ]);

  res.json({ success: true, data: { position, invoices, billable_milestones: billable } });
};

/**
 * Raise a progress application.
 *
 * Bills either a set of completed milestones or an ad-hoc gross amount, takes
 * the client's retention off the top, and writes a real Invoice so it lands in
 * receivables and the ledger like any other. Milestones are stamped with the
 * invoice so the same stage can't be certified twice.
 */
const createProgressInvoice = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  if (!project.customer_id) {
    return res.status(400).json({ success: false, message: 'Link a client to the project before invoicing.' });
  }

  const { milestone_ids, amount, due_date, notes, issue_date } = req.body;
  if (!due_date) return res.status(400).json({ success: false, message: 'A due date is required.' });

  let workValue = 0;
  let lines = [];
  let milestones = [];

  if (Array.isArray(milestone_ids) && milestone_ids.length) {
    milestones = await ProjectMilestone.find({
      _id: { $in: milestone_ids },
      project_id: project._id,
      tenant_id: req.tenant_id,
    });
    if (milestones.length !== milestone_ids.length) {
      return res.status(404).json({ success: false, message: 'One or more milestones could not be found.' });
    }
    const alreadyBilled = milestones.find((m) => m.billed_invoice_id);
    if (alreadyBilled) {
      return res.status(400).json({ success: false, message: `"${alreadyBilled.name}" has already been billed.` });
    }
    workValue = projectService.round2(milestones.reduce((sum, m) => sum + (m.billable_amount || 0), 0));
    lines = milestones.map((m) => ({
      description: m.name,
      quantity: 1,
      unit_price: projectService.round2(m.billable_amount || 0),
      tax_rate: 0,
      total: projectService.round2(m.billable_amount || 0),
    }));
  } else {
    workValue = projectService.round2(Number(amount));
    lines = [{
      description: notes?.trim() || `Work executed — ${project.name}`,
      quantity: 1,
      unit_price: workValue,
      tax_rate: 0,
      total: workValue,
    }];
  }

  if (!Number.isFinite(workValue) || workValue <= 0) {
    return res.status(400).json({ success: false, message: 'Select a milestone to bill, or enter an amount.' });
  }

  // Can't certify past the contract, variations included.
  const position = await projectService.getBillingPosition(project._id, req.tenant_id);
  if (workValue > position.remaining_to_certify) {
    return res.status(400).json({
      success: false,
      message: `Only ${position.currency} ${position.remaining_to_certify.toFixed(2)} of the contract is left to certify.`,
    });
  }

  const retention = projectService.round2(workValue * ((project.retention_pct || 0) / 100));
  const total = projectService.round2(workValue - retention);

  const count = await Invoice.countDocuments({ tenant_id: req.tenant_id });
  const invoice = await Invoice.create({
    tenant_id: req.tenant_id,
    branch_id: project.branch_id,
    invoice_number: `INV-${String(count + 1).padStart(5, '0')}`,
    customer_id: project.customer_id,
    customer_name: project.customer_name,
    issue_date: issue_date || new Date(),
    due_date: new Date(due_date),
    lines,
    subtotal: workValue,
    tax_amount: 0,
    // Retention is withheld by the client, so what falls due is the net.
    total,
    amount_paid: 0,
    amount_due: total,
    status: 'draft',
    notes,
    project_id: project._id,
    work_value: workValue,
    retention_amount: retention,
    created_by: req.user._id,
  });

  if (milestones.length) {
    await ProjectMilestone.updateMany(
      { _id: { $in: milestones.map((m) => m._id) } },
      { billed_invoice_id: invoice._id },
    );
  }

  res.status(201).json({ success: true, data: invoice });
  await audit(req, 'PROJECT_PROGRESS_INVOICE', 'projects',
    `${req.user.name} raised ${invoice.invoice_number} on ${project.code} for ${project.currency} ${total.toFixed(2)}`,
    { invoice_number: invoice.invoice_number, work_value: workValue, retention });
};

/**
 * Bill back retention the client has been holding.
 *
 * Released in stages on most contracts — part at practical completion, the rest
 * once the defects period ends — so the amount is given rather than assumed.
 */
const releaseRetention = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  if (!project.customer_id) {
    return res.status(400).json({ success: false, message: 'Link a client to the project before invoicing.' });
  }

  const { amount, due_date, notes } = req.body;
  if (!due_date) return res.status(400).json({ success: false, message: 'A due date is required.' });

  const position = await projectService.getBillingPosition(project._id, req.tenant_id);
  const value = projectService.round2(Number(amount));
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ success: false, message: 'Enter the amount to release.' });
  }
  if (value > position.retention_outstanding) {
    return res.status(400).json({
      success: false,
      message: `Only ${position.currency} ${position.retention_outstanding.toFixed(2)} of retention is still held.`,
    });
  }

  const count = await Invoice.countDocuments({ tenant_id: req.tenant_id });
  const invoice = await Invoice.create({
    tenant_id: req.tenant_id,
    branch_id: project.branch_id,
    invoice_number: `INV-${String(count + 1).padStart(5, '0')}`,
    customer_id: project.customer_id,
    customer_name: project.customer_name,
    issue_date: new Date(),
    due_date: new Date(due_date),
    lines: [{ description: `Release of retention — ${project.name}`, quantity: 1, unit_price: value, tax_rate: 0, total: value }],
    subtotal: value,
    tax_amount: 0,
    total: value,
    amount_paid: 0,
    amount_due: value,
    status: 'draft',
    notes,
    project_id: project._id,
    // Carries no work_value — it bills back money already certified.
    work_value: 0,
    retention_amount: 0,
    is_retention_release: true,
    created_by: req.user._id,
  });

  res.status(201).json({ success: true, data: invoice });
  await audit(req, 'PROJECT_RETENTION_RELEASE', 'projects',
    `${req.user.name} released ${project.currency} ${value.toFixed(2)} retention on ${project.code}`,
    { invoice_number: invoice.invoice_number, amount: value });
};

module.exports = {
  list, get, create, update, remove, financials,
  addMilestone, updateMilestone, removeMilestone,
  addTask, updateTask, removeTask,
  addVariation, decideVariation, removeVariation,
  listTime, logTime, removeTime,
  billing, createProgressInvoice, releaseRetention,
};
