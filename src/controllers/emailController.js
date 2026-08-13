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

/**
 * Mailboxes a Ghanaian business is actually likely to have, and how to get a
 * password out of each one.
 *
 * The instructions are here rather than in a help page nobody opens, because
 * "app password" is the single thing that stops this working. A business owner
 * types the password they sign in with, Gmail refuses it, and without being
 * told why they conclude the feature is broken.
 *
 * Menus move. Every entry says what to search for if the steps no longer match
 * what is on screen, and links to the provider's own page, which is the one
 * that is right.
 */
const PRESETS = [
  {
    key: 'gmail',
    label: 'Gmail / Google Workspace',
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    username_hint: 'Your full Gmail address, e.g. orders@yourbusiness.com',
    needs_app_password: true,
    note: 'Google refuses the password you sign in with. You need a 16-character app password.',
    help_url: 'https://myaccount.google.com/apppasswords',
    steps: [
      'Turn on 2-Step Verification first, at myaccount.google.com/security. Google will not offer app passwords without it.',
      'Go to myaccount.google.com/apppasswords and sign in again if asked.',
      'Give it a name you will recognise later — GEMS — and choose Create.',
      'Google shows a 16-character password once. Copy it and paste it below; the spaces do not matter.',
      'Close the window. You will not be shown it again, but you can always create another.',
    ],
    caveat: 'On a Workspace account the administrator can switch app passwords off for everyone. '
      + 'If the page says they are unavailable, that is who to ask.',
  },
  {
    key: 'outlook',
    label: 'Outlook / Microsoft 365',
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    username_hint: 'The full address you sign in with',
    needs_app_password: true,
    note: 'Needs an app password once two-step verification is on.',
    help_url: 'https://account.microsoft.com/security',
    steps: [
      'Turn on two-step verification at account.microsoft.com/security.',
      'On a personal Outlook or Hotmail account, open the Advanced security options and choose Create a new app password.',
      'On a work or school Microsoft 365 account, go to mysignins.microsoft.com/security-info, choose Add sign-in method, then App password.',
      'Copy the password it shows and paste it below.',
    ],
    caveat: 'Microsoft switches off SMTP sending for many business accounts by default. If the test '
      + 'fails with an authentication error even on a fresh app password, your IT administrator has to '
      + 'enable SMTP AUTH for this mailbox.',
  },
  {
    key: 'zoho',
    label: 'Zoho Mail',
    host: 'smtp.zoho.com',
    port: 465,
    secure: true,
    username_hint: 'Your full Zoho address',
    needs_app_password: true,
    note: 'Zoho wants TLS on port 465, and an app password.',
    help_url: 'https://accounts.zoho.com',
    steps: [
      'Sign in at accounts.zoho.com and open Security.',
      'Find App Passwords and choose Generate New Password.',
      'Name it GEMS, generate, and copy what it shows.',
      'Paste it below. Leave the port at 465 with TLS on.',
    ],
    caveat: 'If your account is on zoho.eu or another region, the server is smtp.zoho.eu rather than smtp.zoho.com.',
  },
  {
    key: 'titan',
    label: 'Titan (domain mail)',
    host: 'smtp.titan.email',
    port: 465,
    secure: true,
    username_hint: 'Your full address at your own domain',
    needs_app_password: false,
    note: 'Often what comes with a domain bought in Ghana. No app password — the mailbox password works.',
    help_url: '',
    steps: [
      'Use the same password you use to read this mailbox.',
      'If you have forgotten it, reset it wherever you manage the mailbox — usually your domain or hosting provider.',
    ],
    caveat: '',
  },
  {
    key: 'cpanel',
    label: 'cPanel / your web host',
    host: 'mail.yourdomain.com',
    port: 465,
    secure: true,
    username_hint: 'The full address, e.g. info@yourbusiness.com',
    needs_app_password: false,
    note: 'Replace the server with your own domain, as your host gave it to you.',
    help_url: '',
    steps: [
      'Sign in to cPanel and open Email Accounts.',
      'Find the address you want to send from. Use its own password — set a new one there if you do not know it.',
      'Open Connect Devices on that account to see the exact outgoing server and port your host wants. '
        + 'It is usually mail.yourdomain.com on 465.',
    ],
    caveat: 'Some hosts block outgoing mail from other servers until you ask them to allow it. '
      + 'If the test times out, that is worth asking your host about.',
  },
  {
    key: 'other',
    label: 'Something else',
    host: '',
    port: 587,
    secure: false,
    username_hint: 'Usually the full email address',
    needs_app_password: false,
    note: 'Any mailbox that can send by SMTP will work.',
    help_url: '',
    steps: [
      'Search your provider\'s help for "SMTP settings" — they publish the server name and port.',
      'Search it for "app password" too. If the mailbox has two-step verification, you almost certainly need one.',
      'Port 587 with TLS off, or 465 with TLS on, covers nearly every provider.',
    ],
    caveat: '',
  },
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
