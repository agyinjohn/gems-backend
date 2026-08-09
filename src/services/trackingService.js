const crypto = require('crypto');
const {
  Project, ProjectMilestone, Order, Tenant, Invoice, ProjectDocument, ProjectMessage,
} = require('../models');
const projectService = require('./projectService');
const types = require('../config/projectTypes');

/**
 * The read-only view a client is given of their own job.
 *
 * Reached by an unguessable link rather than a login, because the people who
 * need it — a client's site agent, whoever ordered the printing — will not
 * create an account to look at one job, and asking them to is how a feature
 * like this goes unused.
 *
 * That makes what is *not* returned the most important thing here. The link is
 * shareable, forwardable, and effectively public to anyone who receives it, so
 * this builds a whitelist rather than trimming a project down: cost, budget,
 * margin, labour, supplier orders, the cash curve and the site diary never
 * appear, and cannot start appearing because a field was added upstream.
 *
 * What the client does see is what they are already entitled to know: how far
 * along their job is, what has been invoiced to them, and what they have paid.
 */

const { round2 } = projectService;

/** 16 URL-safe characters — enough that guessing is not a strategy. */
const mintToken = () => crypto.randomBytes(12).toString('base64url');

/**
 * The token for a record, creating one on first use.
 *
 * Retried on the vanishingly unlikely collision rather than trusted, since the
 * unique index would otherwise turn it into a 500 on somebody's first share.
 */
async function ensureToken(Model, id, tenantId) {
  const doc = await Model.findOne({ _id: id, tenant_id: tenantId }).select('track_token');
  if (!doc) return null;
  if (doc.track_token) return doc.track_token;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const token = mintToken();
    try {
      await Model.updateOne({ _id: id, tenant_id: tenantId }, { track_token: token });
      return token;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error('Could not generate a tracking link.');
}

/** Strip a token so a shared link can be pulled back. */
async function revokeToken(Model, id, tenantId) {
  await Model.updateOne({ _id: id, tenant_id: tenantId }, { $set: { track_token: null } });
}

/* ── The client's view of a project ───────────────────────────────────────── */

async function trackedProject(project) {
  const [tenant, milestones, invoices, documents, unread] = await Promise.all([
    Tenant.findById(project.tenant_id).select('business_name phone email logo').lean(),
    ProjectMilestone.find({ project_id: project._id, tenant_id: project.tenant_id })
      .select('name status progress_pct planned_end actual_end weight sequence')
      .sort({ sequence: 1, createdAt: 1 }).lean(),
    Invoice.find({ project_id: project._id, tenant_id: project.tenant_id, status: { $ne: 'void' } })
      .select('invoice_number issue_date due_date total amount_paid status is_retention_release')
      .sort({ issue_date: 1 }).lean(),
    // Only what the office deliberately shared, plus whatever the client sent
    // in themselves. Never the rest of the filing cabinet.
    ProjectDocument.find({
      project_id: project._id,
      tenant_id: project.tenant_id,
      $or: [{ shared_with_client: true }, { from_client: true }],
    }).select('name category url size from_client createdAt').sort({ createdAt: -1 }).lean(),
    ProjectMessage.countDocuments({
      project_id: project._id, tenant_id: project.tenant_id, from: 'staff', read_by_client: false,
    }),
  ]);

  const profile = types.profileFor(project.project_type);
  const invoiced = round2(invoices.reduce((s, i) => s + (i.total || 0), 0));
  const paid = round2(invoices.reduce((s, i) => s + (i.amount_paid || 0), 0));

  return {
    kind: 'project',
    business: {
      name: tenant?.business_name || '',
      phone: tenant?.phone || '',
      email: tenant?.email || '',
      logo: tenant?.logo || '',
    },
    reference: project.code,
    title: project.name,
    // The client's own description of the job, not internal notes.
    description: project.description || '',
    stage_word: profile.terms.stages,
    status: project.status,
    progress_pct: round2(project.progress_pct || 0),
    site_address: project.site_address || '',
    start_date: project.start_date || null,
    planned_end_date: project.planned_end_date || null,
    actual_end_date: project.actual_end_date || null,
    currency: project.currency || 'GHS',

    // Names and completion only. Weights and billable amounts are how the job
    // is run internally, not what the client asked about.
    stages: milestones.map((m) => ({
      name: m.name,
      status: m.status,
      progress_pct: round2(m.progress_pct || 0),
      due: m.planned_end || null,
      done_on: m.actual_end || null,
    })),

    // Their own money, and nothing about what the work cost to do.
    billing: {
      invoiced,
      paid,
      outstanding: round2(Math.max(invoiced - paid, 0)),
      invoices: invoices.map((i) => ({
        number: i.invoice_number,
        issued: i.issue_date,
        due: i.due_date,
        total: round2(i.total || 0),
        paid: round2(i.amount_paid || 0),
        status: i.status,
        is_retention_release: !!i.is_retention_release,
      })),
    },
    // Shared both ways. The client can add to this from their own page.
    documents: documents.map((d) => ({
      id: String(d._id),
      name: d.name,
      category: d.category,
      url: d.url,
      size: d.size,
      from_client: !!d.from_client,
      uploaded_at: d.createdAt,
    })),
    unread_messages: unread,
    can_message: true,
    can_upload: true,

    updated_at: project.updatedAt,
  };
}

/* ── The client's view of an order or print job ───────────────────────────── */

/** What a print job is actually doing right now, in the client's words. */
const STAGE_LABEL = {
  awaiting_quote: 'We are pricing your job',
  quoted: 'Quote ready — awaiting your go-ahead',
  queued: 'Accepted and queued',
  preparing: 'Preparing artwork',
  printing: 'Printing',
  finishing: 'Finishing',
  ready: 'Ready for collection',
  collected: 'Collected',
  cancelled: 'Cancelled',
};

async function trackedOrder(order) {
  const tenant = await Tenant.findById(order.tenant_id).select('business_name phone email logo').lean();
  const paid = round2(order.amount_paid ?? (order.payment_status === 'paid' ? order.total : 0));

  return {
    kind: 'order',
    business: {
      name: tenant?.business_name || '',
      phone: tenant?.phone || '',
      email: tenant?.email || '',
      logo: tenant?.logo || '',
    },
    reference: order.order_number,
    title: order.source === 'print_request' ? 'Print job' : 'Order',
    status: order.status,
    production_stage: order.production_stage || null,
    production_label: STAGE_LABEL[order.production_stage] || null,
    quote_status: order.quote_status || null,
    payment_status: order.payment_status,
    currency: 'GHS',

    items: (order.items || []).map((i) => ({
      name: i.product_name,
      quantity: i.quantity,
      unit_price: round2(i.unit_price || 0),
      total: round2(i.total || 0),
      spec: i.print_spec || null,
    })),
    // The client uploaded these, so they may have them back.
    files: (order.files || []).map((f) => ({
      name: f.name, url: f.url, size: f.size, uploaded_at: f.uploaded_at,
    })),

    subtotal: round2(order.subtotal || 0),
    total: round2(order.total || 0),
    paid,
    outstanding: round2(Math.max((order.total || 0) - paid, 0)),
    notes_for_client: order.quote_note || '',
    placed_at: order.createdAt,
    updated_at: order.updatedAt,
  };
}

/**
 * Resolve a link to whatever it points at.
 *
 * Projects are checked first only because they are the smaller collection; both
 * tokens come from the same generator and cannot collide across the two.
 */
async function resolve(token) {
  if (!token || token.length < 8) return null;

  const project = await Project.findOne({ track_token: token }).lean();
  if (project) return trackedProject(project);

  const order = await Order.findOne({ track_token: token }).lean();
  if (order) return trackedOrder(order);

  return null;
}

module.exports = {
  ensureToken,
  revokeToken,
  resolve,
  mintToken,
  STAGE_LABEL,
};
