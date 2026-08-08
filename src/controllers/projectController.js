const {
  Project, ProjectMilestone, ProjectTask, ProjectVariation, ProjectTimeLog,
  ProjectDiary, ProjectDocument, ProjectBaseline, ProjectEotClaim,
  Customer, Employee, Expense, PurchaseOrder, Invoice,
} = require('../models');
const { resolveWriteBranchId } = require('../middleware/branchScope');
const projectService = require('../services/projectService');
const forecastService = require('../services/projectForecastService');
const eotService = require('../services/projectEotService');
const notify = require('../services/notificationService');

/** Dates in a text are read at a glance, so keep them short and unambiguous. */
const shortDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const amount = (n) => Number(n || 0).toFixed(2);
const audit = require('../utils/audit');
const { uploadProjectFile } = require('../services/uploadService');

const scope = (req) => ({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) });

/** Load a project within the caller's tenant and branch scope, or null. */
async function findScoped(req) {
  return Project.findOne({ _id: req.params.id, ...scope(req) });
}

/**
 * Load one of a project's records — a milestone, a task, a diary entry — but
 * only through a project the caller can actually reach.
 *
 * Looking a child up by its own id and the tenant alone gets two things wrong.
 * The obvious one is branch scope: a manager at one branch could reach into
 * another branch's job knowing nothing but an id. The quieter one is that the
 * project in the URL was never checked against the record, so a milestone
 * belonging to one project could be edited down another project's path — and
 * the recalculation afterwards would then quietly correct the wrong job.
 *
 * Both close by going through the project first and matching on it.
 */
async function findChild(req, Model, idParam) {
  const project = await findScoped(req);
  if (!project) return { project: null, doc: null };
  const doc = await Model.findOne({
    _id: req.params[idParam],
    tenant_id: req.tenant_id,
    project_id: project._id,
  });
  return { project, doc };
}

/** The 404 that fits — a project the caller can't see, or a missing record. */
const notFound = (res, project, what) => res.status(404).json({
  success: false,
  message: project ? `${what} not found.` : 'Project not found.',
});

/**
 * Lean reads skip the schema's toJSON transform, so they come back carrying
 * `_id` and no `id`. Clients key rows and build URLs off `id`, so put it back
 * here rather than dropping .lean() and paying for hydrated documents on every
 * list read.
 */
const withId = (doc) => (doc ? { ...doc, id: String(doc._id) } : doc);
const withIds = (docs) => (docs || []).map(withId);

/* ── Projects ─────────────────────────────────────────────────────────────── */

const list = async (req, res) => {
  const { status, search } = req.query;
  const filter = scope(req);
  if (status) filter.status = status;
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { code: new RegExp(search, 'i') }, { customer_name: new RegExp(search, 'i') }];

  const projects = await Project.find(filter)
    .populate('manager_id', 'name')
    .sort({ createdAt: -1 })
    .lean();

  // Overdue is worth seeing in the list rather than only on the detail page.
  const now = Date.now();
  res.json({
    success: true,
    data: projects.map((p) => ({
      ...withId(p),
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
    ProjectTask.find({ project_id: project._id, tenant_id: req.tenant_id }).populate('assignee_id', 'name').sort({ createdAt: 1 }).lean(),
    ProjectVariation.find({ project_id: project._id, tenant_id: req.tenant_id }).sort({ createdAt: -1 }).lean(),
    projectService.getFinancials(project._id, req.tenant_id),
  ]);

  res.json({
    success: true,
    data: {
      project,
      milestones: withIds(milestones),
      tasks: withIds(tasks),
      variations: withIds(variations),
      financials,
    },
  });
};

const create = async (req, res) => {
  const {
    name, description, customer_id, contract_value, currency, budget_lines,
    retention_pct, payment_terms_days, defects_liability_days,
    start_date, planned_end_date, manager_id, team, site_address, status,
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
    payment_terms_days: payment_terms_days !== undefined ? Number(payment_terms_days) : 30,
    defects_liability_days: Number(defects_liability_days) || 0,
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
    'payment_terms_days', 'defects_liability_days', 'working_hours_per_day',
    'client_sms_enabled', 'client_phone',
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
  const { project, doc: milestone } = await findChild(req, ProjectMilestone, 'milestoneId');
  if (!milestone) return notFound(res, project, 'Milestone');

  const wasCompleted = milestone.status === 'completed';

  for (const f of ['name', 'description', 'weight', 'sequence', 'planned_start', 'planned_end', 'billable_amount', 'progress_pct', 'status']) {
    if (req.body[f] !== undefined) milestone[f] = req.body[f];
  }
  if (req.body.status === 'completed') {
    milestone.progress_pct = 100;
    milestone.actual_end ||= new Date();
  }
  if (req.body.status === 'in_progress') milestone.actual_start ||= new Date();

  // Whether this update is what completed the stage, rather than whether the
  // stage happens to be complete — re-saving a finished milestone must not
  // text the client the same news again.
  const justCompleted = wasCompleted !== true && milestone.status === 'completed';

  await milestone.save();
  const progress = await projectService.recalculate(milestone.project_id, req.tenant_id);
  res.json({ success: true, data: milestone, project_progress: progress });

  if (justCompleted) {
    await notify.sendProjectNotification({
      tenantId: req.tenant_id,
      project,
      key: 'project_milestone_completed',
      userId: req.user._id,
      vars: { milestone_name: milestone.name, progress: Math.round(progress) },
    });
  }
};

const removeMilestone = async (req, res) => {
  const { project, doc: milestone } = await findChild(req, ProjectMilestone, 'milestoneId');
  if (!milestone) return notFound(res, project, 'Milestone');
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
  const { project, doc: task } = await findChild(req, ProjectTask, 'taskId');
  if (!task) return notFound(res, project, 'Task');

  for (const f of ['name', 'description', 'milestone_id', 'weight', 'assignee_id', 'due_date', 'status']) {
    if (req.body[f] !== undefined) task[f] = req.body[f];
  }
  task.completed_at = task.status === 'done' ? (task.completed_at || new Date()) : null;

  await task.save();
  const progress = await projectService.recalculate(task.project_id, req.tenant_id);
  res.json({ success: true, data: task, project_progress: progress });
};

const removeTask = async (req, res) => {
  const { project, doc: task } = await findChild(req, ProjectTask, 'taskId');
  if (!task) return notFound(res, project, 'Task');
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
  const { project, doc: variation } = await findChild(req, ProjectVariation, 'variationId');
  if (!variation) return notFound(res, project, 'Variation');

  variation.status = decision;
  variation.decided_on = new Date();
  variation.decided_by = req.user._id;
  await variation.save();

  res.json({ success: true, data: variation });
  await audit(req, 'DECIDE_VARIATION', 'projects', `${req.user.name} ${decision} variation ${variation.reference}`, { reference: variation.reference, amount: variation.amount });
};

const removeVariation = async (req, res) => {
  const { project, doc: variation } = await findChild(req, ProjectVariation, 'variationId');
  if (!variation) return notFound(res, project, 'Variation');
  await variation.deleteOne();
  res.json({ success: true });
};

/* ── Time ─────────────────────────────────────────────────────────────────── */

const listTime = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const logs = await ProjectTimeLog.find({ project_id: project._id, tenant_id: req.tenant_id })
    .populate('employee_id', 'name')
    .sort({ work_date: -1 })
    .limit(200)
    .lean();
  res.json({ success: true, data: withIds(logs) });
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
  const { project, doc: log } = await findChild(req, ProjectTimeLog, 'logId');
  if (!log) return notFound(res, project, 'Time entry');
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

  res.json({
    success: true,
    data: { position, invoices: withIds(invoices), billable_milestones: withIds(billable) },
  });
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
  await notify.sendProjectNotification({
    tenantId: req.tenant_id,
    project,
    key: 'project_application_raised',
    userId: req.user._id,
    vars: {
      invoice_number: invoice.invoice_number,
      // What actually falls due, not the gross certified — the client cares
      // about the figure they have to pay.
      amount: amount(total),
      due_date: shortDate(invoice.due_date),
    },
  });
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
  await notify.sendProjectNotification({
    tenantId: req.tenant_id,
    project,
    key: 'project_retention_release',
    userId: req.user._id,
    vars: {
      invoice_number: invoice.invoice_number,
      amount: amount(value),
      due_date: shortDate(invoice.due_date),
    },
  });
};

/** The formal certificate behind one application, ready to print or send. */
const certificate = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

  const data = await projectService.getPaymentCertificate(project._id, req.tenant_id, req.params.invoiceId);
  if (!data) return res.status(404).json({ success: false, message: 'Invoice not found on this project.' });
  if (data.error) return res.status(400).json({ success: false, message: data.error });

  res.json({ success: true, data });
};

/* ── Baseline programme ───────────────────────────────────────────────────── */

/**
 * Freeze the current programme.
 *
 * Refused on a project with no milestones — a baseline of nothing gives every
 * variance figure a denominator of zero and reads as "on programme" forever,
 * which is worse than having no baseline at all.
 */
const setBaseline = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

  const count = await ProjectMilestone.countDocuments({ project_id: project._id, tenant_id: req.tenant_id });
  if (!count) {
    return res.status(400).json({
      success: false,
      message: 'Add the stages of work before freezing a programme — there is nothing to measure against yet.',
    });
  }
  if (!project.planned_end_date) {
    return res.status(400).json({
      success: false,
      message: 'Set a planned completion date before freezing a programme.',
    });
  }

  const baseline = await forecastService.setBaseline(project._id, req.tenant_id, {
    name: req.body.name,
    reason: req.body.reason,
    userId: req.user._id,
  });

  res.status(201).json({ success: true, data: baseline });
  await audit(req, 'SET_PROJECT_BASELINE', 'projects',
    `${req.user.name} froze programme v${baseline.version} on ${project.code}`,
    { version: baseline.version, name: baseline.name });
};

const listBaselines = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const baselines = await ProjectBaseline.find({ project_id: project._id, tenant_id: req.tenant_id })
    .select('version name reason start_date planned_end_date contract_value is_current createdAt')
    .populate('set_by', 'name')
    .sort({ version: -1 })
    .lean();
  res.json({ success: true, data: withIds(baselines) });
};

const schedule = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const data = await forecastService.getScheduleVariance(project._id, req.tenant_id);
  res.json({ success: true, data });
};

/* ── Extensions of time ───────────────────────────────────────────────────── */

const round1 = (n) => Math.round((n || 0) * 10) / 10;

/** What the diary supports over a window, before anything is claimed from it. */
const eotAnalysis = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const data = await eotService.analysePeriod(project._id, req.tenant_id, {
    from: req.query.from,
    to: req.query.to,
    excludeClaimId: req.query.exclude,
  });
  res.json({ success: true, data });
};

const listEot = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const [claims, position] = await Promise.all([
    ProjectEotClaim.find({ project_id: project._id, tenant_id: req.tenant_id })
      .populate('decided_by', 'name')
      .populate('created_by', 'name')
      .sort({ createdAt: -1 })
      .lean(),
    eotService.getClaimPosition(project._id, req.tenant_id),
  ]);
  res.json({ success: true, data: { claims: withIds(claims), position } });
};

/**
 * Raise a claim.
 *
 * The evidence is frozen onto the claim rather than referenced live. Diary
 * entries stay editable — they have to be, since a day gets written up badly
 * and corrected — but a claim that silently restates itself every time an entry
 * is touched is not a record of anything.
 */
const createEot = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

  const { title, description, period_from, period_to, days_claimed, cost_claimed, submit } = req.body;
  if (!title?.trim()) return res.status(400).json({ success: false, message: 'Give the claim a title.' });
  if (!period_from || !period_to) {
    return res.status(400).json({ success: false, message: 'Set the period the claim covers.' });
  }
  if (new Date(period_from) > new Date(period_to)) {
    return res.status(400).json({ success: false, message: 'The period ends before it starts.' });
  }

  const analysis = await eotService.analysePeriod(project._id, req.tenant_id, {
    from: period_from, to: period_to,
  });
  if (!analysis.claimable_entry_ids.length) {
    return res.status(400).json({
      success: false,
      message: analysis.already_claimed_hours > 0
        ? 'Every delay in that period is already cited on another claim.'
        : 'No lost time is recorded in the diary for that period.',
    });
  }

  // The days claimed stay the claimant's call — entitlement turns on the
  // contract, not on a default table — but a claim for more time than the
  // diary can account for is one the client will simply take apart.
  const days = Number(days_claimed);
  if (!Number.isFinite(days) || days <= 0) {
    return res.status(400).json({ success: false, message: 'Enter the number of days being claimed.' });
  }
  const supported = round1(analysis.hours_lost_total / analysis.working_hours_per_day);
  if (days > supported) {
    return res.status(400).json({
      success: false,
      message: `The diary records ${supported} days of lost time in that period, so ${days} cannot be evidenced from it.`,
    });
  }

  const baseline = await ProjectBaseline.findOne({
    project_id: project._id, tenant_id: req.tenant_id, is_current: true,
  }).select('_id').lean();

  const claim = await ProjectEotClaim.create({
    tenant_id: req.tenant_id,
    project_id: project._id,
    reference: await eotService.nextReference(project._id, req.tenant_id),
    title: title.trim(),
    description,
    period_from: new Date(period_from),
    period_to: new Date(period_to),
    causes: analysis.causes.map((c) => ({
      cause: c.cause,
      hours_lost: c.hours_lost,
      days_equivalent: c.days_equivalent,
      entitlement: c.entitlement,
    })),
    hours_lost_total: analysis.hours_lost_total,
    claimable_hours: analysis.claimable_hours,
    working_hours_per_day: analysis.working_hours_per_day,
    diary_entry_ids: analysis.claimable_entry_ids,
    days_claimed: days,
    cost_claimed: Number(cost_claimed) || 0,
    status: submit ? 'submitted' : 'draft',
    submitted_on: submit ? new Date() : null,
    baseline_id: baseline?._id || null,
    created_by: req.user._id,
  });

  res.status(201).json({ success: true, data: claim });
  await audit(req, 'RAISE_EOT_CLAIM', 'projects',
    `${req.user.name} raised ${claim.reference} on ${project.code} for ${days} days`,
    { reference: claim.reference, days_claimed: days });
};

/**
 * Move a claim along without deciding it — submitting it to the client, or
 * taking it back. The contractor's own side of the exchange.
 */
const updateEot = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

  const claim = await ProjectEotClaim.findOne({ _id: req.params.claimId, tenant_id: req.tenant_id, project_id: project._id });
  if (!claim) return res.status(404).json({ success: false, message: 'Claim not found.' });

  const { action } = req.body;

  if (action === 'submit') {
    if (claim.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Only a draft can be submitted.' });
    }
    claim.status = 'submitted';
    claim.submitted_on = new Date();
    await claim.save();
    return res.json({ success: true, data: claim });
  }

  if (action === 'withdraw') {
    if (['granted', 'partially_granted'].includes(claim.status)) {
      return res.status(400).json({ success: false, message: 'A granted claim cannot be withdrawn — it has to be reopened first.' });
    }
    claim.status = 'withdrawn';
    await claim.save();
    return res.json({ success: true, data: claim });
  }

  if (['title', 'description', 'days_claimed', 'cost_claimed'].some((f) => req.body[f] !== undefined)) {
    if (claim.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Only a draft can be edited. Withdraw it and raise a new one.' });
    }
    if (req.body.title !== undefined) claim.title = req.body.title;
    if (req.body.description !== undefined) claim.description = req.body.description;
    if (req.body.cost_claimed !== undefined) claim.cost_claimed = Number(req.body.cost_claimed) || 0;
    if (req.body.days_claimed !== undefined) {
      const days = Number(req.body.days_claimed);
      const supported = round1(claim.hours_lost_total / (claim.working_hours_per_day || 8));
      if (!Number.isFinite(days) || days <= 0) {
        return res.status(400).json({ success: false, message: 'Enter the number of days being claimed.' });
      }
      if (days > supported) {
        return res.status(400).json({ success: false, message: `The evidence on this claim supports ${supported} days.` });
      }
      claim.days_claimed = days;
    }
    await claim.save();
    return res.json({ success: true, data: claim });
  }

  return res.status(400).json({ success: false, message: 'Nothing to do.' });
};

/**
 * Record the client's decision, and move the completion date with it.
 *
 * Granting time that never reaches the programme is the whole failure this is
 * meant to prevent: the date the job is measured against has to move, or every
 * schedule figure afterwards still shows a delay the client has already
 * accepted. The old date is kept so a decision entered wrongly can be undone.
 */
const decideEot = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

  const claim = await ProjectEotClaim.findOne({ _id: req.params.claimId, tenant_id: req.tenant_id, project_id: project._id });
  if (!claim) return res.status(404).json({ success: false, message: 'Claim not found.' });

  const { decision, days_granted, cost_granted, decision_notes, rebaseline } = req.body;

  // Undo. Only safe while the date is still the one this claim set — if
  // something else has moved it since, putting the old value back would
  // silently discard that change.
  if (decision === 'reopen') {
    if (!['granted', 'partially_granted', 'rejected'].includes(claim.status)) {
      return res.status(400).json({ success: false, message: 'Only a decided claim can be reopened.' });
    }
    if (claim.days_granted > 0) {
      const current = project.planned_end_date ? new Date(project.planned_end_date).getTime() : null;
      const expected = claim.new_end_date ? new Date(claim.new_end_date).getTime() : null;
      if (current !== expected) {
        return res.status(400).json({
          success: false,
          message: 'The completion date has changed since this was granted, so reopening it would undo that change. Adjust the date directly instead.',
        });
      }
      project.planned_end_date = claim.previous_end_date || null;
      await project.save();
    }
    claim.status = 'submitted';
    claim.days_granted = 0;
    claim.cost_granted = 0;
    claim.decided_on = null;
    claim.decided_by = null;
    claim.new_end_date = null;
    claim.previous_end_date = null;
    await claim.save();
    res.json({ success: true, data: claim });
    return;
  }

  if (decision !== 'decide') {
    return res.status(400).json({ success: false, message: 'Unknown decision.' });
  }
  if (!['draft', 'submitted'].includes(claim.status)) {
    return res.status(400).json({ success: false, message: 'This claim has already been decided. Reopen it to change the outcome.' });
  }

  const granted = Number(days_granted);
  if (!Number.isFinite(granted) || granted < 0) {
    return res.status(400).json({ success: false, message: 'Enter the days granted — zero if the claim was refused.' });
  }
  if (granted > claim.days_claimed) {
    return res.status(400).json({ success: false, message: `More days cannot be granted than the ${claim.days_claimed} claimed.` });
  }

  claim.days_granted = granted;
  claim.cost_granted = Number(cost_granted) || 0;
  claim.decision_notes = decision_notes;
  claim.decided_on = new Date();
  claim.decided_by = req.user._id;
  claim.status = granted === 0 ? 'rejected'
    : granted >= claim.days_claimed ? 'granted'
    : 'partially_granted';

  if (granted > 0 && project.planned_end_date) {
    claim.previous_end_date = project.planned_end_date;
    const moved = new Date(project.planned_end_date);
    // UTC arithmetic — a local-time shift would move the date by a day either
    // way depending on the server's zone.
    moved.setUTCDate(moved.getUTCDate() + granted);
    claim.new_end_date = moved;
    project.planned_end_date = moved;
    await project.save();
  }

  await claim.save();

  // An extension changes what the job is measured against, so the programme is
  // normally re-frozen on the back of one. Offered rather than automatic —
  // re-baselining also resets stage-level slip, which is not always wanted.
  if (rebaseline && granted > 0) {
    const fresh = await forecastService.setBaseline(project._id, req.tenant_id, {
      name: `After ${claim.reference}`,
      reason: `${granted} day extension granted on ${claim.reference}`,
      userId: req.user._id,
    });
    claim.rebaselined_to = fresh._id;
    await claim.save();
  }

  res.json({ success: true, data: claim });
  await audit(req, 'DECIDE_EOT_CLAIM', 'projects',
    `${req.user.name} recorded ${granted} of ${claim.days_claimed} days granted on ${claim.reference}`,
    { reference: claim.reference, days_granted: granted, days_claimed: claim.days_claimed });
};

const removeEot = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const claim = await ProjectEotClaim.findOne({ _id: req.params.claimId, tenant_id: req.tenant_id, project_id: project._id });
  if (!claim) return res.status(404).json({ success: false, message: 'Claim not found.' });
  if (['granted', 'partially_granted'].includes(claim.status)) {
    return res.status(400).json({
      success: false,
      message: 'This claim moved the completion date. Reopen it first so the date goes back, then delete it.',
    });
  }
  await claim.deleteOne();
  res.json({ success: true });
};

/* ── Cash flow ────────────────────────────────────────────────────────────── */

const cashflow = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const months = Math.min(36, Math.max(3, parseInt(req.query.months, 10) || 12));
  const data = await forecastService.getCashFlowForecast(project._id, req.tenant_id, { months });
  res.json({ success: true, data });
};

/* ── Site diary ───────────────────────────────────────────────────────────── */

const listDiary = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

  const { from, to } = req.query;
  const filter = { project_id: project._id, tenant_id: req.tenant_id };
  if (from || to) {
    filter.entry_date = {};
    if (from) filter.entry_date.$gte = new Date(from);
    if (to) filter.entry_date.$lte = new Date(to);
  }

  const [entries, summary] = await Promise.all([
    ProjectDiary.find(filter).populate('recorded_by', 'name').sort({ entry_date: -1 }).limit(200).lean(),
    projectService.getDiarySummary(project._id, req.tenant_id),
  ]);

  res.json({ success: true, data: { entries: withIds(entries), summary } });
};

/**
 * Record a day on site.
 *
 * One entry per date — a duplicate would double count lost hours in anything
 * built from these, so a repeat submission updates that day rather than adding
 * a second record.
 */
const saveDiary = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });

  const {
    entry_date, weather, temperature, worked, labour_count, labour_notes,
    plant_notes, work_done, materials_received, delays, visitors, instructions,
  } = req.body;
  if (!entry_date) return res.status(400).json({ success: false, message: 'A date is required.' });

  const cleanDelays = (Array.isArray(delays) ? delays : [])
    .filter((d) => d?.cause)
    .map((d) => ({
      cause: d.cause,
      hours_lost: Math.max(0, Number(d.hours_lost) || 0),
      description: d.description || '',
    }));

  // Normalised to midnight so entries for the same day collide on the unique
  // index regardless of what time they were filed.
  const day = new Date(entry_date);
  day.setHours(0, 0, 0, 0);

  const entry = await ProjectDiary.findOneAndUpdate(
    { project_id: project._id, tenant_id: req.tenant_id, entry_date: day },
    {
      $set: {
        weather: weather || 'fine',
        temperature: temperature !== undefined ? Number(temperature) : undefined,
        worked: worked !== undefined ? !!worked : true,
        labour_count: Number(labour_count) || 0,
        labour_notes, plant_notes, work_done, materials_received,
        delays: cleanDelays,
        visitors, instructions,
        recorded_by: req.user._id,
      },
      $setOnInsert: { project_id: project._id, tenant_id: req.tenant_id, entry_date: day },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  res.status(201).json({ success: true, data: entry });
};

const removeDiary = async (req, res) => {
  const { project, doc: entry } = await findChild(req, ProjectDiary, 'entryId');
  if (!entry) return notFound(res, project, 'Diary entry');
  await entry.deleteOne();
  res.json({ success: true });
};

/* ── Documents ────────────────────────────────────────────────────────────── */

const listDocuments = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  const filter = { project_id: project._id, tenant_id: req.tenant_id };
  if (req.query.category) filter.category = req.query.category;
  const docs = await ProjectDocument.find(filter).populate('uploaded_by', 'name').sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: withIds(docs) });
};

const uploadDocument = async (req, res) => {
  const project = await findScoped(req);
  if (!project) return res.status(404).json({ success: false, message: 'Project not found.' });
  if (!req.file) return res.status(400).json({ success: false, message: 'Choose a file to upload.' });

  const { url, public_id, size } = await uploadProjectFile(req.tenant_id, project._id, req.file);

  const doc = await ProjectDocument.create({
    tenant_id: req.tenant_id,
    project_id: project._id,
    name: req.body.name?.trim() || req.file.originalname,
    category: req.body.category || 'other',
    url,
    public_id,
    mime_type: req.file.mimetype,
    size: size || req.file.size,
    notes: req.body.notes,
    diary_id: req.body.diary_id || null,
    uploaded_by: req.user._id,
  });

  res.status(201).json({ success: true, data: doc });
  await audit(req, 'UPLOAD_PROJECT_DOCUMENT', 'projects',
    `${req.user.name} uploaded ${doc.name} to ${project.code}`, { name: doc.name, category: doc.category });
};

const removeDocument = async (req, res) => {
  const { project, doc } = await findChild(req, ProjectDocument, 'documentId');
  if (!doc) return notFound(res, project, 'Document');
  await doc.deleteOne();
  res.json({ success: true });
};

module.exports = {
  list, get, create, update, remove, financials,
  addMilestone, updateMilestone, removeMilestone,
  addTask, updateTask, removeTask,
  addVariation, decideVariation, removeVariation,
  listTime, logTime, removeTime,
  billing, createProgressInvoice, releaseRetention, certificate,
  setBaseline, listBaselines, schedule, cashflow,
  eotAnalysis, listEot, createEot, updateEot, decideEot, removeEot,
  listDiary, saveDiary, removeDiary,
  listDocuments, uploadDocument, removeDocument,
};
