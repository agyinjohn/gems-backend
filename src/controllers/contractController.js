const { Contract, ContractDocument, Customer, Project } = require('../models');
const { resolveWriteBranchId } = require('../middleware/branchScope');
const audit = require('../utils/audit');
const { uploadContractFile } = require('../services/uploadService');

function httpError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const scope = (req) => ({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) });

async function findOne(req) {
  return Contract.findOne({ _id: req.params.id, ...scope(req) });
}

const label = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ── List ──────────────────────────────────────────────────────────────────────

const list = async (req, res) => {
  const filter = { ...scope(req) };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.customer_id) filter.customer_id = req.query.customer_id;
  if (req.query.contract_type) filter.contract_type = req.query.contract_type;

  const contracts = await Contract.find(filter)
    .sort({ createdAt: -1 })
    .populate('customer_id', 'name company')
    .populate('owner_id', 'name')
    .lean();

  // Attach project count to each contract without a separate query per row.
  const ids = contracts.map((c) => c._id);
  const projectCounts = ids.length ? await Project.aggregate([
    { $match: { tenant_id: req.tenant_id, contract_id: { $in: ids } } },
    { $group: { _id: '$contract_id', count: { $sum: 1 } } },
  ]) : [];
  const countMap = Object.fromEntries(projectCounts.map((r) => [String(r._id), r.count]));

  res.json({
    success: true,
    data: contracts.map((c) => ({
      ...c,
      id: String(c._id),
      project_count: countMap[String(c._id)] || 0,
    })),
  });
};

// ── Create ────────────────────────────────────────────────────────────────────

const create = async (req, res) => {
  const { title, description, customer_id, value, currency, status, signed_date,
    start_date, end_date, renewal_date, auto_renew, contract_type, owner_id } = req.body;

  if (!title) throw httpError('A contract title is required.');

  const branch_id = await resolveWriteBranchId(req);

  // Auto-number: CNT-0001, CNT-0002 …
  const last = await Contract.findOne({ tenant_id: req.tenant_id })
    .sort({ createdAt: -1 }).select('contract_number').lean();
  const seq = last?.contract_number
    ? (parseInt(last.contract_number.replace(/\D/g, ''), 10) || 0) + 1
    : 1;
  const contract_number = `CNT-${String(seq).padStart(4, '0')}`;

  let customer_name;
  if (customer_id) {
    const cust = await Customer.findOne({ _id: customer_id, tenant_id: req.tenant_id }).lean();
    customer_name = cust?.company || cust?.name;
  }

  const contract = await Contract.create({
    tenant_id: req.tenant_id,
    branch_id,
    contract_number,
    title,
    description,
    customer_id: customer_id || undefined,
    customer_name,
    value: Number(value) || 0,
    currency: currency || 'GHS',
    status: status || 'draft',
    signed_date: signed_date || undefined,
    start_date: start_date || undefined,
    end_date: end_date || undefined,
    renewal_date: renewal_date || undefined,
    auto_renew: auto_renew || false,
    contract_type: contract_type || 'service',
    owner_id: owner_id || req.user._id,
    created_by: req.user._id,
  });

  await audit(req, 'CREATE_CONTRACT', 'contracts',
    `${req.user.name} created contract ${contract_number} — ${title}`,
    { contract_number, value });

  res.status(201).json({ success: true, data: { ...contract.toJSON(), id: String(contract._id) } });
};

// ── Get one ───────────────────────────────────────────────────────────────────

const get = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  const projects = await Project.find({
    contract_id: contract._id,
    tenant_id: req.tenant_id,
  }).select('code name status progress_pct contract_value currency project_type start_date planned_end_date').lean();

  res.json({
    success: true,
    data: {
      ...contract.toJSON(),
      id: String(contract._id),
      projects: projects.map((p) => ({ ...p, id: String(p._id) })),
    },
  });
};

// ── Update ────────────────────────────────────────────────────────────────────

const update = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  const fields = ['title', 'description', 'value', 'currency', 'status',
    'signed_date', 'start_date', 'end_date', 'renewal_date', 'auto_renew', 'contract_type', 'owner_id'];
  fields.forEach((f) => { if (req.body[f] !== undefined) contract[f] = req.body[f]; });

  if (req.body.customer_id !== undefined) {
    contract.customer_id = req.body.customer_id || undefined;
    if (req.body.customer_id) {
      const cust = await Customer.findOne({ _id: req.body.customer_id, tenant_id: req.tenant_id }).lean();
      contract.customer_name = cust?.company || cust?.name;
    } else {
      contract.customer_name = undefined;
    }
  }

  await contract.save();
  await audit(req, 'UPDATE_CONTRACT', 'contracts',
    `${req.user.name} updated contract ${contract.contract_number}`, {});

  res.json({ success: true, data: { ...contract.toJSON(), id: String(contract._id) } });
};

// ── Delete ────────────────────────────────────────────────────────────────────

const remove = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  // Unlink projects rather than blocking the delete.
  await Project.updateMany({ contract_id: contract._id }, { $unset: { contract_id: 1 } });
  await contract.deleteOne();

  await audit(req, 'DELETE_CONTRACT', 'contracts',
    `${req.user.name} deleted contract ${contract.contract_number} — ${contract.title}`, {});

  res.json({ success: true });
};

// ── Link / unlink a project ───────────────────────────────────────────────────

const linkProject = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  const project = await Project.findOne({ _id: req.params.projectId, tenant_id: req.tenant_id });
  if (!project) throw httpError('Project not found.', 404);

  project.contract_id = contract._id;
  await project.save();

  res.json({ success: true });
};

const unlinkProject = async (req, res) => {
  const project = await Project.findOne({ _id: req.params.projectId, tenant_id: req.tenant_id });
  if (!project) throw httpError('Project not found.', 404);

  project.contract_id = undefined;
  await project.save();

  res.json({ success: true });
};

// ── Documents ─────────────────────────────────────────────────────────────────

const uploadDocument = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);
  if (!req.file) throw httpError('No file received.');

  const uploaded = await uploadContractFile(req.tenant_id, contract._id, req.file);

  contract.documents.push({
    name: req.body.name || req.file.originalname,
    url: uploaded.url,
    public_id: uploaded.public_id,
    size: uploaded.size,
    category: req.body.category || 'contract',
    uploaded_by: req.user._id,
  });
  await contract.save();

  res.status(201).json({ success: true, data: contract.documents[contract.documents.length - 1] });
};

const removeDocument = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  const doc = contract.documents.id(req.params.docId);
  if (!doc) throw httpError('Document not found.', 404);

  doc.deleteOne();
  await contract.save();

  res.json({ success: true });
};

// ── Notes ─────────────────────────────────────────────────────────────────────

const addNote = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);
  if (!req.body.body?.trim()) throw httpError('Note body is required.');

  contract.notes.push({ body: req.body.body.trim(), created_by: req.user._id });
  await contract.save();

  res.status(201).json({ success: true, data: contract.notes[contract.notes.length - 1] });
};

const removeNote = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  const note = contract.notes.id(req.params.noteId);
  if (!note) throw httpError('Note not found.', 404);

  note.deleteOne();
  await contract.save();

  res.json({ success: true });
};

// ── Payment schedule ─────────────────────────────────────────────────────────

const addPaymentMilestone = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  const { label, pct, amount, due_date } = req.body;
  if (!label?.trim()) throw httpError('A label is required.');

  contract.payment_schedule.push({ label: label.trim(), pct: Number(pct) || 0, amount: Number(amount) || 0, due_date: due_date || undefined });
  await contract.save();

  res.status(201).json({ success: true, data: contract.payment_schedule[contract.payment_schedule.length - 1] });
};

const updatePaymentMilestone = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  const ms = contract.payment_schedule.id(req.params.milestoneId);
  if (!ms) throw httpError('Milestone not found.', 404);

  ['label', 'pct', 'amount', 'due_date', 'status', 'invoice_id'].forEach((f) => {
    if (req.body[f] !== undefined) ms[f] = req.body[f];
  });
  await contract.save();

  res.json({ success: true, data: ms });
};

const removePaymentMilestone = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  const ms = contract.payment_schedule.id(req.params.milestoneId);
  if (!ms) throw httpError('Milestone not found.', 404);

  ms.deleteOne();
  await contract.save();

  res.json({ success: true });
};

// ── Signatories ───────────────────────────────────────────────────────────────

const addSignatory = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  const { party, name, role, email, phone } = req.body;
  if (!party || !name?.trim()) throw httpError('party and name are required.');
  if (!['client', 'internal'].includes(party)) throw httpError('party must be client or internal.');

  contract.signatories.push({ party, name: name.trim(), role, email, phone });
  await contract.save();

  res.status(201).json({ success: true, data: contract.signatories[contract.signatories.length - 1] });
};

const updateSignatory = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  const sig = contract.signatories.id(req.params.signatoryId);
  if (!sig) throw httpError('Signatory not found.', 404);

  ['name', 'role', 'email', 'phone', 'signed', 'signed_at'].forEach((f) => {
    if (req.body[f] !== undefined) sig[f] = req.body[f];
  });
  // Mark signed_at automatically when signed flips to true.
  if (req.body.signed === true && !sig.signed_at) sig.signed_at = new Date();
  await contract.save();

  res.json({ success: true, data: sig });
};

const removeSignatory = async (req, res) => {
  const contract = await findOne(req);
  if (!contract) throw httpError('Contract not found.', 404);

  const sig = contract.signatories.id(req.params.signatoryId);
  if (!sig) throw httpError('Signatory not found.', 404);

  sig.deleteOne();
  await contract.save();

  res.json({ success: true });
};

module.exports = {
  list, create, get, update, remove,
  linkProject, unlinkProject,
  uploadDocument, removeDocument,
  addNote, removeNote,
  addPaymentMilestone, updatePaymentMilestone, removePaymentMilestone,
  addSignatory, updateSignatory, removeSignatory,
};
