const { Tenant, PlatformSettings, SmsPurchase, SmsTemplate, SmsMessage } = require('../models');
const { verifyPaystackTransaction } = require('../services/paymentService');
const sms = require('../services/smsService');

const DEFAULT_BUNDLES = [
  { label: 'Starter',  credits: 100,  price: 15 },
  { label: 'Business', credits: 500,  price: 65 },
  { label: 'Bulk',     credits: 2000, price: 230 },
];

async function getBundles() {
  const settings = await PlatformSettings.findOne().select('sms_bundles').lean();
  const bundles = Array.isArray(settings?.sms_bundles) && settings.sms_bundles.length
    ? settings.sms_bundles
    : DEFAULT_BUNDLES;
  return bundles
    .filter((b) => Number(b?.credits) > 0 && Number(b?.price) >= 0)
    .map((b) => ({
      label: b.label || `${b.credits} SMS`,
      credits: Number(b.credits),
      price: Number(b.price),
      // Shown so a tenant can compare bundles rather than guess.
      unit_price: Math.round((Number(b.price) / Number(b.credits)) * 100) / 100,
    }));
}

/* ── Balance & bundles ────────────────────────────────────────────────────── */

const getBalance = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id).select('sms_credits sms_settings').lean();
  const credits = tenant?.sms_credits || 0;
  const lowAt = tenant?.sms_settings?.low_balance_at ?? 20;

  const [sent, blocked] = await Promise.all([
    SmsMessage.countDocuments({ tenant_id: req.tenant_id, status: 'sent' }),
    SmsMessage.countDocuments({ tenant_id: req.tenant_id, status: 'insufficient_credits' }),
  ]);

  res.json({
    success: true,
    data: {
      credits,
      is_low: credits <= lowAt,
      low_balance_at: lowAt,
      enabled: tenant?.sms_settings?.enabled !== false,
      sender_id: tenant?.sms_settings?.sender_id || '',
      messages_sent: sent,
      messages_blocked: blocked,
      bundles: await getBundles(),
    },
  });
};

const updateSettings = async (req, res) => {
  const { sender_id, enabled, low_balance_at } = req.body;
  const update = {};
  if (sender_id !== undefined) {
    const id = String(sender_id).trim();
    // Alphanumeric sender IDs are capped at 11 characters by the GSM spec.
    if (id.length > 11) {
      return res.status(400).json({ success: false, message: 'Sender ID cannot be longer than 11 characters.' });
    }
    update['sms_settings.sender_id'] = id;
  }
  if (enabled !== undefined) update['sms_settings.enabled'] = !!enabled;
  if (low_balance_at !== undefined) {
    const n = Number(low_balance_at);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ success: false, message: 'low_balance_at must be a positive number.' });
    }
    update['sms_settings.low_balance_at'] = n;
  }
  if (!Object.keys(update).length) {
    return res.status(400).json({ success: false, message: 'Nothing to update.' });
  }
  await Tenant.findByIdAndUpdate(req.tenant_id, { $set: update });
  res.json({ success: true });
};

/* ── Buying credits ───────────────────────────────────────────────────────── */

const purchase = async (req, res) => {
  const { credits } = req.body;
  const wanted = Number(credits);

  const bundles = await getBundles();
  const bundle = bundles.find((b) => b.credits === wanted);
  if (!bundle) {
    return res.status(400).json({ success: false, message: 'Choose one of the available bundles.' });
  }

  const tenant = await Tenant.findById(req.tenant_id).select('email').lean();
  const reference = `SMS-${String(req.tenant_id).slice(-6)}-${Date.now().toString(36).toUpperCase()}`;

  const tx = await SmsPurchase.create({
    tenant_id: req.tenant_id,
    credits: bundle.credits,
    amount: bundle.price,
    bundle_label: bundle.label,
    status: 'pending',
    reference,
    initiated_by: req.user._id,
  });

  const settings = await PlatformSettings.findOne().select('paystack_public_key').lean();

  res.status(201).json({
    success: true,
    data: {
      purchase_id: tx._id,
      credits: bundle.credits,
      amount: bundle.price,
      label: bundle.label,
      email: tenant?.email,
      reference,
      paystack_public_key: settings?.paystack_public_key || process.env.PAYSTACK_PUBLIC_KEY,
    },
  });
};

/**
 * Confirm a bundle purchase and credit the tenant.
 *
 * Verifies against Paystack rather than trusting the client, and the status
 * check makes it idempotent so a repeated callback can't credit twice.
 */
const verifyPurchase = async (req, res) => {
  const { reference, purchase_id } = req.body;
  if (!reference || !purchase_id) {
    return res.status(400).json({ success: false, message: 'reference and purchase_id are required.' });
  }

  const tx = await SmsPurchase.findOne({ _id: purchase_id, tenant_id: req.tenant_id });
  if (!tx) return res.status(404).json({ success: false, message: 'Purchase not found.' });
  if (tx.status === 'success') {
    return res.status(400).json({ success: false, message: 'This purchase has already been credited.' });
  }

  try {
    const txData = await verifyPaystackTransaction(reference);

    // Claim the row before crediting, so two concurrent callbacks can't both
    // pass the status check above and add the credits twice.
    const claimed = await SmsPurchase.findOneAndUpdate(
      { _id: tx._id, status: { $ne: 'success' } },
      { status: 'success', payment_ref: reference, payment_method: txData?.channel || 'paystack' },
      { new: true },
    );
    if (!claimed) {
      return res.status(400).json({ success: false, message: 'This purchase has already been credited.' });
    }

    const updated = await Tenant.findByIdAndUpdate(
      req.tenant_id,
      { $inc: { sms_credits: tx.credits } },
      { new: true },
    ).select('sms_credits');

    res.json({
      success: true,
      message: `${tx.credits} SMS credits added.`,
      data: { credits: updated?.sms_credits || 0, added: tx.credits },
    });
  } catch (err) {
    tx.status = 'failed';
    await tx.save();
    res.status(400).json({ success: false, message: err.message || 'Payment verification failed.' });
  }
};

const listPurchases = async (req, res) => {
  const purchases = await SmsPurchase.find({ tenant_id: req.tenant_id })
    .populate('initiated_by', 'name')
    .sort({ createdAt: -1 })
    .limit(50);
  res.json({ success: true, data: purchases });
};

/* ── Templates ────────────────────────────────────────────────────────────── */

const listTemplates = async (req, res) => {
  res.json({
    success: true,
    data: await sms.listTemplates(req.tenant_id),
    variables: sms.TEMPLATE_VARIABLES,
  });
};

const updateTemplate = async (req, res) => {
  const { key } = req.params;
  const { body, enabled } = req.body;

  if (!sms.DEFAULT_TEMPLATES[key]) {
    return res.status(404).json({ success: false, message: 'Unknown template.' });
  }

  const update = { updated_by: req.user._id };
  if (body !== undefined) {
    const text = String(body).trim();
    if (!text) return res.status(400).json({ success: false, message: 'Message cannot be empty.' });
    if (text.length > 640) {
      return res.status(400).json({ success: false, message: 'Message is too long — keep it under 640 characters.' });
    }
    update.body = text;
  }
  if (enabled !== undefined) update.enabled = !!enabled;

  // Seed from the built-in default so switching a template off without editing
  // it still writes a valid row.
  await SmsTemplate.findOneAndUpdate(
    { tenant_id: req.tenant_id, key },
    { $set: update, $setOnInsert: { tenant_id: req.tenant_id, key, body: sms.DEFAULT_TEMPLATES[key].body } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const templates = await sms.listTemplates(req.tenant_id);
  res.json({ success: true, data: templates.find((t) => t.key === key) });
};

/** Drop the override so the built-in default applies again. */
const resetTemplate = async (req, res) => {
  const { key } = req.params;
  if (!sms.DEFAULT_TEMPLATES[key]) {
    return res.status(404).json({ success: false, message: 'Unknown template.' });
  }
  await SmsTemplate.deleteOne({ tenant_id: req.tenant_id, key });
  const templates = await sms.listTemplates(req.tenant_id);
  res.json({ success: true, data: templates.find((t) => t.key === key) });
};

/** Preview what a template will actually send, and what it will cost. */
const previewTemplate = async (req, res) => {
  const { body } = req.body;
  const tenant = await Tenant.findById(req.tenant_id).select('business_name').lean();
  const rendered = sms.renderTemplate(body || '', {
    customer_name: 'Ama Mensah',
    order_number: 'ORD-1042',
    total: '250.00',
    status: 'confirmed',
    business_name: tenant?.business_name || 'Your business',
  });
  res.json({
    success: true,
    data: {
      preview: rendered,
      characters: rendered.length,
      segments: sms.countSegments(rendered),
      unicode: !sms.isGsm7(rendered),
    },
  });
};

/* ── Messages ─────────────────────────────────────────────────────────────── */

const listMessages = async (req, res) => {
  const { status } = req.query;
  const filter = { tenant_id: req.tenant_id };
  if (status) filter.status = status;
  const messages = await SmsMessage.find(filter).sort({ createdAt: -1 }).limit(100);
  res.json({ success: true, data: messages });
};

/** Send an ad-hoc message — spends credits like any other send. */
const sendTest = async (req, res) => {
  const { to, body } = req.body;
  if (!to || !body?.trim()) {
    return res.status(400).json({ success: false, message: 'A recipient and message are required.' });
  }
  const result = await sms.sendSms({
    tenantId: req.tenant_id,
    to,
    body: body.trim(),
    source: 'manual',
    userId: req.user._id,
  });
  if (!result.sent) {
    const message = result.reason === 'insufficient_credits'
      ? 'Not enough SMS credits. Buy a bundle to continue sending.'
      : result.reason || 'Could not send the message.';
    return res.status(400).json({ success: false, message, data: result });
  }
  res.json({ success: true, data: result });
};

module.exports = {
  getBalance,
  updateSettings,
  purchase,
  verifyPurchase,
  listPurchases,
  listTemplates,
  updateTemplate,
  resetTemplate,
  previewTemplate,
  listMessages,
  sendTest,
};
