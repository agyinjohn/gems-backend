const crypto = require('crypto');
const { Tenant, Product, Order, Customer } = require('../models');
const {
  initializePaystackTransaction, fetchPaystackTransaction,
  isPaystackTransactionPaid, fulfillStorefrontOrders, resolvePaystackEmail,
} = require('../services/paymentService');
const { buildSplitForCheckout } = require('../services/splitService');
const tracking = require('../services/trackingService');
const { uploadServiceFile } = require('../services/uploadService');
const types = require('../config/serviceTypes');
const jobs = require('../services/jobService');
const audit = require('../utils/audit');

/**
 * Service requests.
 *
 * A client asks for work — printing, a repair, a design, a site visit — picks
 * from the shop's price list, sends anything needed with it, and gets a
 * reference back. The shop prices whatever the list can't, and only then is
 * there a job.
 *
 * This began as print requests and outgrew the name. Nothing about the flow was
 * ever specific to printing: what the client chooses is whatever the business
 * has published as a service, and it always did. Only the vocabulary and the
 * mandatory file were, and both now come from the service itself — see
 * config/serviceTypes.js.
 *
 * Quote-first rather than pay-first on purpose: a shop needs to see the job
 * before it can honestly commit to a price — a "20-page document" arrives as 34
 * pages with a fold-out, and "the fridge is not cooling" is a compressor or a
 * door seal — and taking money before looking is how work ends up done at a
 * loss or refunded.
 *
 * The intake half of this is unauthenticated, so it is written defensively:
 * only services the shop has published are sellable, every price comes from the
 * catalogue rather than the request, and nothing the client sends is trusted to
 * be a number.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ── Public: what the shop sells ──────────────────────────────────────────── */

async function findStore(slug) {
  return Tenant.findOne({ slug, is_active: true }).select('_id business_name slug phone email logo').lean();
}

/**
 * The services a client may choose from.
 *
 * Only services, only active ones, and only from this shop. A product is
 * excluded because a service request is for work done, not stock sold.
 */
const publicServices = async (req, res) => {
  const store = await findStore(req.params.tenantSlug);
  if (!store) return res.status(404).json({ success: false, message: 'Store not found.' });

  const services = await Product.find({
    tenant_id: store._id,
    item_type: 'service',
    is_active: { $ne: false },
  }).select('name description price unit_type pricing_mode min_price max_price category_id service_type requires_file')
    .sort({ name: 1 }).lean();

  res.json({
    success: true,
    data: {
      store: { name: store.business_name, slug: store.slug, phone: store.phone, email: store.email, logo: store.logo },
      services: services.map((s) => ({
        id: String(s._id),
        name: s.name,
        description: s.description || '',
        unit_type: s.unit_type || 'unit',
        service_type: types.profileFor(s.service_type).key,
        // Told to the client up front, so the form can ask for the file at the
        // point they pick the service rather than rejecting the whole request
        // after they have filled everything in.
        requires_file: !!s.requires_file,
        // A service the shop prices by hand has no figure to show — saying
        // "we'll quote it" is honest, where showing 0.00 is not.
        priced: s.pricing_mode !== 'open',
        price: s.pricing_mode === 'open' ? null : round2(s.price),
      })),
    },
  });
};

/* ── Public: submitting a request ─────────────────────────────────────────── */

/**
 * Take a request in.
 *
 * Everything chargeable is looked up server-side. The client says which service
 * and how many; what it costs is never read from the request, because that
 * field is under the sender's control.
 */
const submitRequest = async (req, res) => {
  const store = await findStore(req.params.tenantSlug);
  if (!store) return res.status(404).json({ success: false, message: 'Store not found.' });

  const { customer_name, customer_phone, customer_email, notes } = req.body;
  if (!customer_name?.trim()) return res.status(400).json({ success: false, message: 'Please give your name.' });
  if (!customer_phone?.trim()) return res.status(400).json({ success: false, message: 'Please give a phone number so we can reach you.' });

  // Sent as JSON inside multipart, since the files travel alongside.
  let lines = [];
  try {
    lines = JSON.parse(req.body.lines || '[]');
  } catch {
    return res.status(400).json({ success: false, message: 'Could not read the selected services.' });
  }
  if (!Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ success: false, message: 'Choose at least one service.' });
  }

  const ids = [...new Set(lines.map((l) => String(l.service_id)).filter(Boolean))];
  const services = await Product.find({
    _id: { $in: ids }, tenant_id: store._id, item_type: 'service', is_active: { $ne: false },
  }).lean();
  const byId = new Map(services.map((s) => [String(s._id), s]));
  if (services.length !== ids.length) {
    return res.status(400).json({ success: false, message: 'One of the services is no longer offered.' });
  }

  // Only some work needs something sent in. Printing cannot start without the
  // artwork; nobody can attach a blocked drain. The service says which it is,
  // and it is checked here rather than trusted from the form, because the form
  // is not the only thing that can post here.
  const needsFile = services.filter((s) => s.requires_file);
  if (needsFile.length && !req.files?.length) {
    const names = needsFile.map((s) => s.name).join(', ');
    return res.status(400).json({
      success: false,
      message: `Attach the file for ${names} — we can't start without it.`,
    });
  }

  const items = [];
  let needsQuote = false;
  for (const line of lines) {
    const service = byId.get(String(line.service_id));
    if (!service) continue;
    const qty = Math.max(1, Math.floor(Number(line.quantity) || 1));
    // A service the shop prices by hand goes in at zero and is quoted. Anything
    // else is priced from the catalogue — never from the request body.
    const open = service.pricing_mode === 'open';
    if (open) needsQuote = true;
    const unit = open ? 0 : round2(service.price);
    items.push({
      product_id: service._id,
      product_name: service.name,
      quantity: qty,
      unit_price: unit,
      total: round2(unit * qty),
      item_type: 'service',
      spec: String(line.spec || '').slice(0, 300),
    });
  }
  if (!items.length) return res.status(400).json({ success: false, message: 'Choose at least one service.' });

  const uploaded = [];
  for (const file of req.files || []) {
    const saved = await uploadServiceFile(store._id, file);
    uploaded.push({
      name: file.originalname,
      url: saved.url,
      public_id: saved.public_id,
      mime_type: file.mimetype,
      size: saved.size || file.size,
    });
  }

  const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
  const serviceType = types.typeForLines(services);
  const count = await Order.countDocuments({ tenant_id: store._id });
  const order = await Order.create({
    tenant_id: store._id,
    order_number: `SRQ-${String(count + 1).padStart(5, '0')}`,
    customer_name: customer_name.trim(),
    customer_phone: customer_phone.trim(),
    customer_email: customer_email?.trim() || undefined,
    items,
    subtotal,
    total: subtotal,
    source: 'service_request',
    service_type: serviceType,
    status: 'pending',
    payment_status: 'pending',
    // Everything lands as a quote, even when every line priced cleanly — the
    // shop still has to look at what was asked for and confirm it can be done
    // as described.
    quote_status: 'awaiting_quote',
    production_stage: 'awaiting_quote',
    files: uploaded,
    notes: notes?.trim() || undefined,
    track_token: tracking.mintToken(),
  });

  res.status(201).json({
    success: true,
    data: {
      reference: order.order_number,
      track_token: order.track_token,
      estimated_total: subtotal,
      needs_quote: needsQuote,
    },
  });
};

/* ── Staff: the queue ─────────────────────────────────────────────────────── */

const scope = (req) => ({ tenant_id: req.tenant_id, ...(req.branchFilter || {}) });

/** The finished stages, across every type — what "still open" is measured against. */
const CLOSED_STAGES = [
  ...new Set([...types.TYPE_KEYS.map((t) => types.finalStageKey(t)), types.CANCELLED.key]),
];

/** A request, plus the stages its own type runs through, for the UI to offer. */
const shape = (order) => ({
  ...order,
  id: String(order._id),
  service_type: types.profileFor(order.service_type).key,
  stages: types.workStagesFor(order.service_type),
  // The job this became, named rather than just referenced — an id tells the
  // office nothing, and the code is what they will go and look for.
  job: order.job_id && order.job_id.code
    ? { id: String(order.job_id._id), code: order.job_id.code, title: order.job_id.title }
    : null,
  job_id: order.job_id ? String(order.job_id._id || order.job_id) : null,
});

const list = async (req, res) => {
  const filter = { ...scope(req), source: 'service_request' };
  if (req.query.stage) filter.production_stage = req.query.stage;
  if (req.query.type) filter.service_type = req.query.type;
  if (req.query.open === 'true') filter.production_stage = { $nin: CLOSED_STAGES };

  const orders = await Order.find(filter).sort({ createdAt: -1 })
    .populate('job_id', 'code title').limit(300).lean();
  res.json({ success: true, data: orders.map(shape) });
};

const get = async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, ...scope(req), source: 'service_request' })
    .populate('job_id', 'code title').lean();
  if (!order) return res.status(404).json({ success: false, message: 'Service request not found.' });
  res.json({ success: true, data: shape(order) });
};

/** The catalogue of service types, so the UI can label and offer stages. */
const typeCatalogue = (req, res) => {
  res.json({
    success: true,
    data: types.TYPE_KEYS.map((key) => {
      const profile = types.profileFor(key);
      return {
        key,
        label: profile.label,
        description: profile.description,
        requires_file: profile.requires_file,
        stages: types.stagesFor(key),
      };
    }),
  });
};

/**
 * Price the job and send it back.
 *
 * Line prices are set here rather than adjusted line by line, because a quote
 * is one number the client either agrees to or doesn't — half-quoted is not a
 * state anybody can act on.
 */
const quote = async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, ...scope(req), source: 'service_request' });
  if (!order) return res.status(404).json({ success: false, message: 'Service request not found.' });
  if (['accepted'].includes(order.quote_status)) {
    return res.status(400).json({ success: false, message: 'This job has already been accepted by the client.' });
  }

  const { lines, note } = req.body;
  if (Array.isArray(lines)) {
    for (const line of lines) {
      const item = order.items.id?.(line.id) || order.items.find((i) => String(i._id) === String(line.id));
      if (!item) continue;
      if (line.unit_price !== undefined) item.unit_price = round2(line.unit_price);
      if (line.quantity !== undefined) item.quantity = Math.max(1, Math.floor(Number(line.quantity) || 1));
      item.total = round2(item.unit_price * item.quantity);
    }
  }

  order.subtotal = round2(order.items.reduce((s, i) => s + (i.total || 0), 0));
  order.total = order.subtotal;
  if (order.total <= 0) {
    return res.status(400).json({ success: false, message: 'Put a price on the job before sending the quote.' });
  }

  order.quote_status = 'quoted';
  order.quote_note = note || '';
  order.quoted_at = new Date();
  order.quoted_by = req.user._id;
  order.production_stage = 'quoted';
  await order.save();

  res.json({ success: true, data: shape(order.toJSON()) });
  await audit(req, 'QUOTE_SERVICE_REQUEST', 'sales',
    `${req.user.name} quoted ${order.order_number} at GHS ${order.total.toFixed(2)}`,
    { reference: order.order_number, total: order.total });
};

/** Move the job along. */
const setStage = async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, ...scope(req), source: 'service_request' });
  if (!order) return res.status(404).json({ success: false, message: 'Service request not found.' });

  const { stage } = req.body;
  const type = types.profileFor(order.service_type).key;
  // A repair does not go "on the press". Each type may only be moved through
  // its own stages, plus the two before the work and the way out — checking
  // against the column's full enum would let any stage onto any job.
  const isWork = types.isWorkStage(type, stage);
  const permitted = isWork
    || stage === types.CANCELLED.key
    || types.LEAD_IN.some((s) => s.key === stage);
  if (!permitted) {
    return res.status(400).json({
      success: false,
      message: `That is not a stage a ${types.profileFor(type).label.toLowerCase()} job goes through.`,
    });
  }

  // Work cannot start on a price nobody has agreed to.
  if (isWork && order.quote_status !== 'accepted') {
    return res.status(400).json({
      success: false,
      message: 'The client has not accepted the quote yet, so the job cannot be started.',
    });
  }

  order.production_stage = stage;
  // Keep the order's own lifecycle in step, so these read sensibly wherever
  // orders are listed.
  if (stage === types.finalStageKey(type)) order.status = 'completed';
  else if (stage === types.CANCELLED.key) order.status = 'cancelled';
  else if (isWork) order.status = 'in_progress';
  await order.save();

  res.json({ success: true, data: shape(order.toJSON()) });
};

/* ── Public: the client's answer ──────────────────────────────────────────── */

/**
 * Accept or decline a quote, from the tracking link.
 *
 * The token is the authority. It was sent to the person who made the request,
 * and accepting a quote commits only them.
 */
const respondToQuote = async (req, res) => {
  const order = await Order.findOne({ track_token: req.params.token, source: 'service_request' });
  if (!order) return res.status(404).json({ success: false, message: 'Job not found.' });
  if (order.quote_status !== 'quoted') {
    return res.status(400).json({ success: false, message: 'There is no quote waiting on this job.' });
  }

  const { decision } = req.body;
  if (!['accepted', 'declined'].includes(decision)) {
    return res.status(400).json({ success: false, message: 'Say whether you accept the quote.' });
  }

  order.quote_status = decision;
  if (decision === 'accepted') {
    order.accepted_at = new Date();
    // Straight to whatever this trade's first step is — "in the queue" for a
    // print job, "scheduled" for a site visit.
    order.production_stage = types.workStagesFor(order.service_type)[0].key;
    order.status = 'in_progress';

    // An accepted quote is work, so the shop gets a job for it rather than
    // somebody retyping the request. Deliberately not fatal: the client's
    // acceptance is their decision and must stand even if this fails, and the
    // request still lists in the queue either way. A missing job is visible —
    // the request shows no job — and recoverable; a refused acceptance is not.
    try {
      const job = await jobs.createFromServiceRequest(order);
      if (job) order.job_id = job._id;
    } catch (err) {
      console.error(`[ServiceRequest] Could not raise a job for ${order.order_number}:`, err.message);
    }
  } else {
    order.production_stage = 'cancelled';
    order.status = 'cancelled';
  }
  await order.save();

  res.json({ success: true, data: { quote_status: order.quote_status, production_stage: order.production_stage } });
};

/* ── Public: paying for the job ───────────────────────────────────────────── */

/**
 * Start a payment from the tracking link.
 *
 * Initialised server-side rather than handing the browser a public key and an
 * amount. This page is reachable by anyone holding the link, and an amount set
 * in the browser is an amount the payer chooses — Paystack is given the figure
 * from the order and returns a code the client can only pay as issued.
 */
const startPayment = async (req, res) => {
  const order = await Order.findOne({ track_token: req.params.token, source: 'service_request' });
  if (!order) return res.status(404).json({ success: false, message: 'Job not found.' });

  if (order.payment_status === 'paid') {
    return res.status(400).json({ success: false, message: 'This job has already been paid for.' });
  }
  // Paying for a price nobody agreed to is how a dispute starts.
  if (order.quote_status !== 'accepted') {
    return res.status(400).json({ success: false, message: 'Accept the quote before paying.' });
  }
  if (!(order.total > 0)) {
    return res.status(400).json({ success: false, message: 'This job has no amount to pay yet.' });
  }

  const tenant = await Tenant.findById(order.tenant_id).select('business_name email').lean();
  const reference = `SRQ-${crypto.randomBytes(6).toString('hex')}`;

  // Where the shop has a subaccount, their share settles straight to it and the
  // platform's cut is taken at the gateway — the same arrangement storefront
  // checkout uses, so payouts behave identically whichever way a sale arrived.
  const split = await buildSplitForCheckout({
    tenantId: order.tenant_id,
    amount: order.total,
    viaMarketplace: false,
  });

  const email = await resolvePaystackEmail({
    customerEmail: order.customer_email,
    tenantEmail: tenant?.email,
    reference,
  });

  let tx;
  try {
    tx = await initializePaystackTransaction({
      email,
      amount: order.total,
      reference,
      metadata: { pos_order_id: String(order._id), order_number: order.order_number },
      ...(split && { subaccount: split.subaccount, transaction_charge: split.transaction_charge }),
    });
  } catch (err) {
    return res.status(502).json({ success: false, message: err.message || 'Could not start the payment.' });
  }

  order.payment_ref = reference;
  if (split) {
    order.subaccount_code = split.subaccount;
    order.platform_fee = split.commission;
    order.split_settled = true;
  }
  await order.save();

  res.json({
    success: true,
    data: {
      access_code: tx.access_code,
      authorization_url: tx.authorization_url,
      reference,
      amount: order.total,
      business: tenant?.business_name || '',
    },
  });
};

/**
 * Confirm it landed.
 *
 * The gateway is asked, not the browser. Amount and order are both checked
 * against what Paystack actually took, so a reference from a different or
 * cheaper transaction is refused. Fulfilment is idempotent, so a client
 * refreshing the page cannot be credited twice.
 */
const confirmPayment = async (req, res) => {
  const order = await Order.findOne({ track_token: req.params.token, source: 'service_request' });
  if (!order) return res.status(404).json({ success: false, message: 'Job not found.' });
  if (order.payment_status === 'paid') {
    return res.json({ success: true, data: { already_paid: true } });
  }

  const reference = req.body.reference || order.payment_ref;
  if (!reference) return res.status(400).json({ success: false, message: 'No payment to confirm.' });

  let tx;
  try {
    tx = await fetchPaystackTransaction(reference);
  } catch (err) {
    return res.status(502).json({ success: false, message: err.message || 'Could not reach the payment gateway.' });
  }

  if (!isPaystackTransactionPaid(tx, order.total, order._id)) {
    return res.status(400).json({ success: false, message: 'That payment has not gone through.' });
  }

  await fulfillStorefrontOrders({ reference, orderIds: [order._id] });
  res.json({ success: true, data: { paid: true } });
};

module.exports = {
  publicServices,
  typeCatalogue,
  submitRequest,
  startPayment,
  confirmPayment,
  list,
  get,
  quote,
  setStage,
  respondToQuote,
};
