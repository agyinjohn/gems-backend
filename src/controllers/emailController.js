const { Tenant, EmailTemplate, EmailMessage } = require('../models');
const email = require('../services/emailService');
const audit = require('../utils/audit');

/**
 * Email settings, wording and history for a tenant.
 *
 * The mailbox password is write-only from here: it goes in, it never comes back
 * out. The page shows whether one is set, not what it is.
 */

/* ── Settings ─────────────────────────────────────────────────────────────── */

/** Mailboxes a Ghanaian business is actually likely to have. */
const PRESETS = [
  { key: 'gmail',     label: 'Gmail / Google Workspace', host: 'smtp.gmail.com',        port: 587, secure: false, note: 'Needs an app password, not your everyday one — Google blocks the everyday one.' },
  { key: 'outlook',   label: 'Outlook / Microsoft 365',  host: 'smtp.office365.com',    port: 587, secure: false, note: 'Use the full address as the username.' },
  { key: 'zoho',      label: 'Zoho Mail',                host: 'smtp.zoho.com',         port: 465, secure: true,  note: 'Zoho wants TLS on port 465.' },
  { key: 'titan',     label: 'Titan (domain mail)',      host: 'smtp.titan.email',      port: 465, secure: true,  note: 'Often what comes with a domain bought in Ghana.' },
  { key: 'cpanel',    label: 'cPanel / your web host',   host: 'mail.yourdomain.com',   port: 465, secure: true,  note: 'Replace the host with your own domain, as your host gave it.' },
];

const getSettings = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id).select('email_settings business_name').lean();
  const s = tenant?.email_settings || {};
  const [sent, failed] = await Promise.all([
    EmailMessage.countDocuments({ tenant_id: req.tenant_id, status: 'sent' }),
    EmailMessage.countDocuments({ tenant_id: req.tenant_id, status: { $in: ['failed', 'not_configured'] } }),
  ]);

  res.json({
    success: true,
    data: {
      enabled: s.enabled !== false,
      from_name: s.from_name || '',
      from_email: s.from_email || '',
      reply_to: s.reply_to || '',
      smtp: {
        host: s.smtp?.host || '',
        port: s.smtp?.port || 587,
        secure: !!s.smtp?.secure,
        username: s.smtp?.username || '',
        // Never the password itself — only whether there is one.
        password_set: !!s.smtp?.password,
      },
      ...email.readiness(s),
      last_error: s.last_error || '',
      sends: sent,
      failures: failed,
      presets: PRESETS,
      // What the recipient will see in the From column.
      preview_from: s.from_email ? email.fromAddress(s, tenant?.business_name) : '',
    },
  });
};

const updateSettings = async (req, res) => {
  const { enabled, from_name, from_email, reply_to, smtp = {} } = req.body;
  const update = {};

  if (enabled !== undefined) update['email_settings.enabled'] = !!enabled;
  if (from_name !== undefined) update['email_settings.from_name'] = String(from_name).trim();

  for (const [field, value] of [['from_email', from_email], ['reply_to', reply_to]]) {
    if (value === undefined) continue;
    const address = String(value).trim().toLowerCase();
    if (address && !email.looksLikeEmail(address)) {
      return res.status(400).json({ success: false, message: `${address} is not an email address.` });
    }
    update[`email_settings.${field}`] = address;
  }

  if (smtp.host !== undefined) update['email_settings.smtp.host'] = String(smtp.host).trim();
  if (smtp.username !== undefined) update['email_settings.smtp.username'] = String(smtp.username).trim();
  if (smtp.secure !== undefined) update['email_settings.smtp.secure'] = !!smtp.secure;
  if (smtp.port !== undefined) {
    const port = Number(smtp.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ success: false, message: 'That is not a valid port. Most mailboxes use 587, or 465 with TLS.' });
    }
    update['email_settings.smtp.port'] = port;
  }
  // An empty password means "leave the one already stored alone", so saving the
  // rest of the form doesn't wipe a working mailbox.
  if (smtp.password) update['email_settings.smtp.password'] = email.encryptSecret(String(smtp.password));

  // Anything changed here might have broken it, so the last verification and
  // the last error both stop applying.
  if (Object.keys(update).some((k) => k.startsWith('email_settings.smtp') || k === 'email_settings.from_email')) {
    update['email_settings.verified_at'] = null;
    update['email_settings.last_error'] = '';
  }

  await Tenant.findByIdAndUpdate(req.tenant_id, update);
  await audit(req, 'UPDATE_EMAIL_SETTINGS', 'settings', `${req.user.name} updated the email settings`);
  return getSettings(req, res);
};

/** Try the mailbox without sending anything, so a wrong password says so. */
const verify = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id).select('email_settings').lean();
  const result = await email.verifyConnection(tenant?.email_settings || {});
  await Tenant.findByIdAndUpdate(req.tenant_id, result.ok
    ? { 'email_settings.verified_at': new Date(), 'email_settings.last_error': '' }
    : { 'email_settings.last_error': result.reason });
  if (!result.ok) return res.status(400).json({ success: false, message: result.reason });
  res.json({ success: true, message: 'The mailbox answered. Email is ready to send.' });
};

/* ── Templates ────────────────────────────────────────────────────────────── */

const listTemplates = async (req, res) => {
  res.json({ success: true, data: await email.listTemplates(req.tenant_id) });
};

const updateTemplate = async (req, res) => {
  const { key } = req.params;
  const { subject, body, enabled } = req.body;
  if (!email.DEFAULT_TEMPLATES[key]) {
    return res.status(404).json({ success: false, message: 'No such template.' });
  }
  const base = email.DEFAULT_TEMPLATES[key];
  const existing = await EmailTemplate.findOne({ tenant_id: req.tenant_id, key }).lean();

  const next = {
    subject: (subject ?? existing?.subject ?? base.subject).trim(),
    body: (body ?? existing?.body ?? base.body).trim(),
    enabled: enabled === undefined ? (existing?.enabled ?? true) : !!enabled,
  };
  if (!next.subject) return res.status(400).json({ success: false, message: 'An email needs a subject line.' });
  if (!next.body) return res.status(400).json({ success: false, message: 'An email needs something to say.' });

  await EmailTemplate.findOneAndUpdate(
    { tenant_id: req.tenant_id, key },
    { ...next, updated_by: req.user._id },
    { upsert: true, new: true },
  );
  const templates = await email.listTemplates(req.tenant_id);
  res.json({ success: true, data: templates.find((t) => t.key === key) });
};

const resetTemplate = async (req, res) => {
  const { key } = req.params;
  if (!email.DEFAULT_TEMPLATES[key]) {
    return res.status(404).json({ success: false, message: 'No such template.' });
  }
  await EmailTemplate.deleteOne({ tenant_id: req.tenant_id, key });
  const templates = await email.listTemplates(req.tenant_id);
  res.json({ success: true, data: templates.find((t) => t.key === key) });
};

/** What a template will actually say, with a plausible order filled in. */
const previewTemplate = async (req, res) => {
  const { subject, body } = req.body;
  const tenant = await Tenant.findById(req.tenant_id).select('business_name email_settings').lean();
  const vars = {
    customer_name: 'Ama Mensah',
    order_number: 'ORD-1042',
    total: '250.00',
    status: 'confirmed',
    project_name: 'Head office fit-out',
    project_code: 'PRJ-004',
    invoice_number: 'INV-0007',
    amount: '4,500.00',
    balance: '1,200.00',
    due_date: '30 Sep 2026',
    milestone_name: 'First fix',
    progress: '45',
    business_name: tenant?.business_name || 'Your business',
  };
  res.json({
    success: true,
    data: {
      subject: email.renderTemplate(subject || '', vars),
      body: email.renderTemplate(body || '', vars),
      from: tenant?.email_settings?.from_email
        ? email.fromAddress(tenant.email_settings, tenant.business_name)
        : '',
    },
  });
};

/* ── History and ad-hoc sends ─────────────────────────────────────────────── */

const listMessages = async (req, res) => {
  const { status } = req.query;
  const filter = { tenant_id: req.tenant_id };
  if (status) filter.status = status;
  const messages = await EmailMessage.find(filter).sort({ createdAt: -1 }).limit(100);
  res.json({ success: true, data: messages });
};

/** Write to a client from here — also how the settings are proved end to end. */
const send = async (req, res) => {
  const { to, subject, body } = req.body;
  if (!to || !subject?.trim() || !body?.trim()) {
    return res.status(400).json({ success: false, message: 'A recipient, a subject and a message are all required.' });
  }
  const result = await email.sendEmail({
    tenantId: req.tenant_id,
    to,
    subject: subject.trim(),
    body: body.trim(),
    source: 'manual',
    userId: req.user._id,
  });
  if (!result.sent) {
    const message = result.reason === 'not_configured'
      ? `Email is not set up yet: ${(result.missing || []).join(', ')}.`
      : result.reason === 'email_disabled'
        ? 'Email is switched off for this business.'
        : result.reason || 'The message could not be sent.';
    return res.status(400).json({ success: false, message, data: result });
  }
  res.json({ success: true, message: 'Sent.', data: result });
};

module.exports = {
  getSettings,
  updateSettings,
  verify,
  listTemplates,
  updateTemplate,
  resetTemplate,
  previewTemplate,
  listMessages,
  send,
};
