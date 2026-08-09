const { Tenant, Product, Order, Customer } = require('../models');
const tracking = require('../services/trackingService');
const { uploadPrintFile } = require('../services/uploadService');
const audit = require('../utils/audit');

/**
 * Print requests.
 *
 * A client sends the file they want printed, picks from the shop's price list,
 * and gets a reference back. The shop prices anything the list can't, and only
 * then is there a job.
 *
 * Quote-first rather than pay-first on purpose: a print shop needs to see the
 * file before it can honestly commit to a price — a "20-page document" arrives
 * as 34 pages with a fold-out — and taking money before looking is how a job
 * ends up produced at a loss or refunded.
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
 * The printing services a client may choose from.
 *
 * Only services, only active ones, and only from this shop. A product is
 * excluded because a print request is for work done, not stock sold.
 */
const publicServices = async (req, res) => {
  const store = await findStore(req.params.tenantSlug);
  if (!store) return res.status(404).json({ success: false, message: 'Store not found.' });

  const services = await Product.find({
    tenant_id: store._id,
    item_type: 'service',
    is_active: { $ne: false },
  }).select('name description price unit_type pricing_mode min_price max_price category_id').sort({ name: 1 }).lean();

  res.json({
    success: true,
    data: {
      store: { name: store.business_name, slug: store.slug, phone: store.phone, email: store.email, logo: store.logo },
      services: services.map((s) => ({
        id: String(s._id),
        name: s.name,
        description: s.description || '',
        unit_type: s.unit_type || 'unit',
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
  if (!req.files?.length) {
    return res.status(400).json({ success: false, message: 'Attach the file you want printed.' });
  }

  const ids = [...new Set(lines.map((l) => String(l.service_id)).filter(Boolean))];
  const services = await Product.find({
    _id: { $in: ids }, tenant_id: store._id, item_type: 'service', is_active: { $ne: false },
  }).lean();
  const byId = new Map(services.map((s) => [String(s._id), s]));
  if (services.length !== ids.length) {
    return res.status(400).json({ success: false, message: 'One of the services is no longer offered.' });
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
      print_spec: String(line.spec || '').slice(0, 300),
    });
  }
  if (!items.length) return res.status(400).json({ success: false, message: 'Choose at least one service.' });

  const uploaded = [];
  for (const file of req.files) {
    const saved = await uploadPrintFile(store._id, file);
    uploaded.push({
      name: file.originalname,
      url: saved.url,
      public_id: saved.public_id,
      mime_type: file.mimetype,
      size: saved.size || file.size,
    });
  }

  const subtotal = round2(items.reduce((s, i) => s + i.total, 0));
  const count = await Order.countDocuments({ tenant_id: store._id });
  const order = await Order.create({
    tenant_id: store._id,
    order_number: `PRQ-${String(count + 1).padStart(5, '0')}`,
    customer_name: customer_name.trim(),
    customer_phone: customer_phone.trim(),
    customer_email: customer_email?.trim() || undefined,
    items,
    subtotal,
    total: subtotal,
    source: 'print_request',
    status: 'pending',
    payment_status: 'pending',
    // Everything lands as a quote, even when every line priced cleanly — the
    // shop still has to open the file and confirm it can be printed as asked.
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

const list = async (req, res) => {
  const filter = { ...scope(req), source: 'print_request' };
  if (req.query.stage) filter.production_stage = req.query.stage;
  if (req.query.open === 'true') filter.production_stage = { $nin: ['collected', 'cancelled'] };

  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(300).lean();
  res.json({
    success: true,
    data: orders.map((o) => ({ ...o, id: String(o._id) })),
  });
};

const get = async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, ...scope(req), source: 'print_request' }).lean();
  if (!order) return res.status(404).json({ success: false, message: 'Print request not found.' });
  res.json({ success: true, data: { ...order, id: String(order._id) } });
};

/**
 * Price the job and send it back.
 *
 * Line prices are set here rather than adjusted line by line, because a quote
 * is one number the client either agrees to or doesn't — half-quoted is not a
 * state anybody can act on.
 */
const quote = async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, ...scope(req), source: 'print_request' });
  if (!order) return res.status(404).json({ success: false, message: 'Print request not found.' });
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

  res.json({ success: true, data: { ...order.toJSON(), id: String(order._id) } });
  await audit(req, 'QUOTE_PRINT_REQUEST', 'sales',
    `${req.user.name} quoted ${order.order_number} at GHS ${order.total.toFixed(2)}`,
    { reference: order.order_number, total: order.total });
};

/** Move the job along the shop floor. */
const setStage = async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, ...scope(req), source: 'print_request' });
  if (!order) return res.status(404).json({ success: false, message: 'Print request not found.' });

  const { stage } = req.body;
  const allowed = Order.schema.path('production_stage').enumValues;
  if (!allowed.includes(stage)) {
    return res.status(400).json({ success: false, message: 'Unknown stage.' });
  }
  // Work cannot start on a price nobody has agreed to.
  const started = ['queued', 'preparing', 'printing', 'finishing', 'ready', 'collected'];
  if (started.includes(stage) && order.quote_status !== 'accepted') {
    return res.status(400).json({
      success: false,
      message: 'The client has not accepted the quote yet, so the job cannot be started.',
    });
  }

  order.production_stage = stage;
  // Keep the order's own lifecycle in step, so print jobs read sensibly
  // wherever orders are listed.
  if (stage === 'collected') order.status = 'completed';
  else if (stage === 'cancelled') order.status = 'cancelled';
  else if (started.includes(stage)) order.status = 'in_progress';
  await order.save();

  res.json({ success: true, data: { ...order.toJSON(), id: String(order._id) } });
};

/* ── Public: the client's answer ──────────────────────────────────────────── */

/**
 * Accept or decline a quote, from the tracking link.
 *
 * The token is the authority. It was sent to the person who made the request,
 * and accepting a quote commits only them.
 */
const respondToQuote = async (req, res) => {
  const order = await Order.findOne({ track_token: req.params.token, source: 'print_request' });
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
    order.production_stage = 'queued';
    order.status = 'in_progress';
  } else {
    order.production_stage = 'cancelled';
    order.status = 'cancelled';
  }
  await order.save();

  res.json({ success: true, data: { quote_status: order.quote_status, production_stage: order.production_stage } });
};

module.exports = {
  publicServices,
  submitRequest,
  list,
  get,
  quote,
  setStage,
  respondToQuote,
};
