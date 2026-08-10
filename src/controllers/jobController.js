const { Job, Customer, Employee, Invoice } = require('../models');
const { resolveWriteBranchId } = require('../middleware/branchScope');
const { TYPE_KEYS, profileFor } = require('../config/serviceTypes');
const audit = require('../utils/audit');
const jobService = require('../services/jobService');

function httpError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const scope = (req) => ({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) });

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── List ──────────────────────────────────────────────────────────────────────

const list = async (req, res) => {
  const filter = { ...scope(req) };
  if (req.query.status)      filter.status   = req.query.status;
  if (req.query.job_type)    filter.job_type  = req.query.job_type;
  if (req.query.assigned_to) filter.assigned_to = req.query.assigned_to;
  if (req.query.contract_id) filter.contract_id = req.query.contract_id;
  if (req.query.project_id)  filter.project_id  = req.query.project_id;
  if (req.query.open === 'true') filter.status = { $in: ['open', 'in_progress', 'done'] };

  const jobs = await Job.find(filter)
    .sort({ createdAt: -1 })
    .populate('assigned_to', 'name')
    .lean();

  // Client-side search — small datasets, avoids a text index dependency.
  const q = (req.query.search || '').toLowerCase().trim();
  const data = q
    ? jobs.filter(j =>
        j.title.toLowerCase().includes(q) ||
        j.code.toLowerCase().includes(q) ||
        (j.customer_name || '').toLowerCase().includes(q),
      )
    : jobs;

  res.json({ success: true, data: data.map(withId) });
};

// ── Create ────────────────────────────────────────────────────────────────────

const create = async (req, res) => {
  const { title, description, customer_id, job_type, items, assigned_to, due_date, notes,
    walk_in_name, walk_in_phone, contract_id, project_id } = req.body;
  if (!title?.trim()) throw httpError('A job title is required.');

  const branch_id = await resolveWriteBranchId(req);

  // Shared with the accept-a-quote path, so a job raised from a request and one
  // typed by hand are numbered the same way.
  const code = await jobService.nextJobCode(req.tenant_id);

  let customer_name;
  if (customer_id) {
    const cust = await Customer.findOne({ _id: customer_id, tenant_id: req.tenant_id }).lean();
    customer_name = cust?.company || cust?.name;
  }

  let assigned_name;
  if (assigned_to) {
    const emp = await Employee.findOne({ _id: assigned_to, tenant_id: req.tenant_id }).lean();
    assigned_name = emp?.name;
  }

  const lines = buildLines(items || []);

  const job = await Job.create({
    tenant_id: req.tenant_id,
    branch_id,
    code,
    title: title.trim(),
    description,
    customer_id:   customer_id   || undefined,
    customer_name,
    job_type:      job_type      || 'general',
    items:         lines,
    assigned_to:   assigned_to   || undefined,
    assigned_name,
    walk_in_name:  walk_in_name  || undefined,
    walk_in_phone: walk_in_phone || undefined,
    contract_id:   contract_id   || undefined,
    project_id:    project_id    || undefined,
    due_date:      due_date      || undefined,
    notes,
    created_by: req.user._id,
  });

  await audit(req, 'CREATE_JOB', 'jobs',
    `${req.user.name} created job ${code} — ${title}`, { code });

  res.status(201).json({ success: true, data: withId(job.toJSON()) });
};

// ── Get one ───────────────────────────────────────────────────────────────────

const get = async (req, res) => {
  const job = await Job.findOne({ _id: req.params.id, ...scope(req) })
    .populate('assigned_to', 'name')
    .populate('invoice_id', 'invoice_number status total')
    .lean();
  if (!job) throw httpError('Job not found.', 404);
  res.json({ success: true, data: withId(job) });
};

// ── Update ────────────────────────────────────────────────────────────────────

const update = async (req, res) => {
  const job = await Job.findOne({ _id: req.params.id, ...scope(req) });
  if (!job) throw httpError('Job not found.', 404);
  if (job.status === 'invoiced') throw httpError('An invoiced job cannot be edited.');

  const fields = ['title', 'description', 'job_type', 'due_date', 'notes', 'status', 'walk_in_name', 'walk_in_phone'];
  fields.forEach((f) => { if (req.body[f] !== undefined) job[f] = req.body[f]; });

  // Sent empty, these clear the link rather than being ignored — moving a job
  // out from under a contract has to be as possible as moving it in.
  if (req.body.contract_id !== undefined) job.contract_id = req.body.contract_id || undefined;
  if (req.body.project_id  !== undefined) job.project_id  = req.body.project_id  || undefined;
  // Where the work came from is a fact about its history, not a field to edit.
  

  if (req.body.status === 'done' && !job.completed_date) job.completed_date = new Date();

  if (req.body.customer_id !== undefined) {
    job.customer_id = req.body.customer_id || undefined;
    if (req.body.customer_id) {
      const cust = await Customer.findOne({ _id: req.body.customer_id, tenant_id: req.tenant_id }).lean();
      job.customer_name = cust?.company || cust?.name;
    } else {
      job.customer_name = undefined;
    }
  }

  if (req.body.assigned_to !== undefined) {
    job.assigned_to = req.body.assigned_to || undefined;
    if (req.body.assigned_to) {
      const emp = await Employee.findOne({ _id: req.body.assigned_to, tenant_id: req.tenant_id }).lean();
      job.assigned_name = emp?.name;
    } else {
      job.assigned_name = undefined;
    }
  }

  if (req.body.items !== undefined) job.items = buildLines(req.body.items);

  await job.save();
  res.json({ success: true, data: withId(job.toJSON()) });
};

// ── Delete ────────────────────────────────────────────────────────────────────

const remove = async (req, res) => {
  const job = await Job.findOne({ _id: req.params.id, ...scope(req) });
  if (!job) throw httpError('Job not found.', 404);
  if (job.status === 'invoiced') throw httpError('An invoiced job cannot be deleted. Void the invoice first.');

  await job.deleteOne();
  await audit(req, 'DELETE_JOB', 'jobs',
    `${req.user.name} deleted job ${job.code} — ${job.title}`, { code: job.code });

  res.json({ success: true });
};

// ── Invoice ───────────────────────────────────────────────────────────────────
// Raises an Invoice from the job's items and marks the job as invoiced.
// Keeps it simple: one invoice per job, blocked if already invoiced.

const invoice = async (req, res) => {
  const job = await Job.findOne({ _id: req.params.id, ...scope(req) });
  if (!job) throw httpError('Job not found.', 404);
  if (job.status === 'invoiced') throw httpError('This job has already been invoiced.');
  // Walk-in name takes precedence over CRM customer name for invoicing.
  const billingName = job.walk_in_name || job.customer_name;
  if (!billingName) throw httpError('Add a client name or walk-in name before invoicing.');

  const branch_id = await resolveWriteBranchId(req);

  // Auto-number invoice
  const count = await Invoice.countDocuments({ tenant_id: req.tenant_id });
  const invoice_number = `INV-${String(count + 1).padStart(5, '0')}`;

  const due_date = req.body.due_date
    ? new Date(req.body.due_date)
    : new Date(Date.now() + 30 * 86400000); // 30-day default

  const subtotal = job.items.reduce((s, i) => s + i.total, 0);

  const inv = await Invoice.create({
    tenant_id:      req.tenant_id,
    branch_id,
    invoice_number,
    customer_id:    job.customer_id,
    customer_name:  billingName,
    customer_phone: job.walk_in_phone || undefined,
    issue_date:     new Date(),
    due_date,
    lines: job.items.map((i) => ({
      description: i.description,
      quantity:    i.quantity,
      unit_price:  i.unit_price,
      total:       i.total,
    })),
    subtotal,
    total:      subtotal,
    amount_due: subtotal,
    notes:      req.body.notes || `Job ${job.code} — ${job.title}`,
    created_by: req.user._id,
  });

  job.status     = 'invoiced';
  job.invoice_id = inv._id;
  await job.save();

  await audit(req, 'INVOICE_JOB', 'jobs',
    `${req.user.name} invoiced job ${job.code} → ${invoice_number}`,
    { code: job.code, invoice_number });

  res.status(201).json({ success: true, data: { invoice: withId(inv.toJSON()), job: withId(job.toJSON()) } });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildLines(items) {
  return (items || []).map((i) => {
    const qty   = round2(i.quantity  ?? 1);
    const price = round2(i.unit_price ?? 0);
    return { description: String(i.description || ''), quantity: qty, unit_price: price, total: round2(qty * price) };
  });
}

const withId = (doc) => (doc ? { ...doc, id: String(doc._id) } : doc);

module.exports = { list, create, get, update, remove, invoice };
