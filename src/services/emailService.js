const crypto = require('crypto');
const { Tenant, EmailTemplate, EmailMessage } = require('../models');

/**
 * Email — the tenant's own mailbox, their own wording, and a record of every
 * attempt.
 *
 * Deliberately not the platform's mail server. A quote from Ama's Prints has to
 * arrive from Ama's Prints: mail sent on somebody else's domain lands in spam,
 * and a customer who hits reply must reach the business rather than us. So the
 * business supplies the mailbox it already owns — a Gmail, a Workspace account,
 * whatever came with the domain — and GEMS posts through it.
 *
 * Shaped like smsService on purpose: the same template keys, the same "return a
 * result, never throw" contract, the same one-row-per-attempt log. The
 * differences are the ones that are real — a subject line, no credits to spend,
 * and a body that can be a paragraph because nobody is charged by the character.
 */

const nodemailer = require('nodemailer');

/* ── Built-in templates ────────────────────────────────────────────────────
 *
 * Keys match smsService, so one event can reach a customer both ways and a
 * business that wants only one channel just switches the other off. Only
 * customised ones are stored, so new templates ship without a migration.
 */
const ORDER_VARIABLES = [
  '{{customer_name}}', '{{order_number}}', '{{total}}', '{{business_name}}', '{{status}}',
];
const PROJECT_VARIABLES = [
  '{{customer_name}}', '{{project_name}}', '{{project_code}}', '{{business_name}}',
];

const DEFAULT_TEMPLATES = {
  order_confirmed: {
    group: 'Orders',
    label: 'Order confirmed',
    description: 'Sent when a customer’s payment succeeds.',
    variables: ORDER_VARIABLES,
    subject: 'Your order {{order_number}} is confirmed',
    body: 'Hi {{customer_name}},\n\n'
      + 'Thank you — we have received your payment of GH₵ {{total}} and your order {{order_number}} is confirmed.\n\n'
      + 'We will be in touch as soon as it is on its way.\n\n'
      + 'Kind regards,\n{{business_name}}',
  },
  order_shipped: {
    group: 'Orders',
    label: 'Order shipped',
    description: 'Sent when an order is marked shipped.',
    variables: ORDER_VARIABLES,
    subject: 'Your order {{order_number}} is on its way',
    body: 'Hi {{customer_name}},\n\n'
      + 'Your order {{order_number}} has left us and is on its way to you.\n\n'
      + 'Kind regards,\n{{business_name}}',
  },
  order_delivered: {
    group: 'Orders',
    label: 'Order delivered',
    description: 'Sent when an order is marked delivered.',
    variables: ORDER_VARIABLES,
    subject: 'Your order {{order_number}} has been delivered',
    body: 'Hi {{customer_name}},\n\n'
      + 'Your order {{order_number}} has been delivered. We hope everything is as you expected — '
      + 'if anything is not, please reply to this email and we will put it right.\n\n'
      + 'Kind regards,\n{{business_name}}',
  },
  order_cancelled: {
    group: 'Orders',
    label: 'Order cancelled',
    description: 'Sent when an order is cancelled.',
    variables: ORDER_VARIABLES,
    subject: 'Your order {{order_number}} has been cancelled',
    body: 'Hi {{customer_name}},\n\n'
      + 'Your order {{order_number}} has been cancelled. If this is unexpected, please reply to this '
      + 'email and we will look into it.\n\n'
      + 'Kind regards,\n{{business_name}}',
  },

  project_application_raised: {
    group: 'Projects',
    label: 'Application raised',
    description: 'Sent when a progress application is raised on a project.',
    variables: [...PROJECT_VARIABLES, '{{invoice_number}}', '{{amount}}', '{{due_date}}'],
    subject: 'Application {{invoice_number}} — {{project_name}}',
    body: 'Hi {{customer_name}},\n\n'
      + 'Application {{invoice_number}} for GH₵ {{amount}} on {{project_name}} has been raised and is '
      + 'due on {{due_date}}.\n\n'
      + 'Kind regards,\n{{business_name}}',
  },
  project_payment_received: {
    group: 'Projects',
    label: 'Payment received',
    description: 'Sent when a payment is recorded against a project invoice.',
    variables: [...PROJECT_VARIABLES, '{{invoice_number}}', '{{amount}}', '{{balance}}'],
    subject: 'We have received your payment — {{project_name}}',
    body: 'Hi {{customer_name}},\n\n'
      + 'Thank you. We have received GH₵ {{amount}} towards {{project_name}}. The balance outstanding '
      + 'on {{invoice_number}} is GH₵ {{balance}}.\n\n'
      + 'Kind regards,\n{{business_name}}',
  },
  project_milestone_completed: {
    group: 'Projects',
    label: 'Stage completed',
    description: 'Sent when a milestone on a project is marked complete.',
    variables: [...PROJECT_VARIABLES, '{{milestone_name}}', '{{progress}}'],
    subject: '{{milestone_name}} is complete — {{project_name}}',
    body: 'Hi {{customer_name}},\n\n'
      + '{{milestone_name}} on {{project_name}} is now complete, which puts the job at {{progress}} '
      + 'percent overall.\n\n'
      + 'Kind regards,\n{{business_name}}',
  },
};

/** Every variable any template understands. */
const TEMPLATE_VARIABLES = [...new Set(
  Object.values(DEFAULT_TEMPLATES).flatMap((t) => t.variables),
)];

/* ── Storing the mailbox password ─────────────────────────────────────────── */

// An app password for somebody's mailbox is not ours to keep in the clear. It
// is encrypted with a key derived from the server's own secret, which means a
// dump of the database on its own does not hand over anyone's email account.
const ENC_PREFIX = 'enc:v1:';

function encryptionKey() {
  const secret = process.env.EMAIL_SECRET || process.env.JWT_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptSecret(plain) {
  if (!plain) return '';
  const key = encryptionKey();
  if (!key) return plain; // No secret configured; storing it is still better than losing it.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ENC_PREFIX + [iv, cipher.getAuthTag(), out].map((b) => b.toString('base64')).join(':');
}

function decryptSecret(stored) {
  if (!stored) return '';
  if (!String(stored).startsWith(ENC_PREFIX)) return String(stored);
  const key = encryptionKey();
  if (!key) return '';
  try {
    const [iv, tag, data] = String(stored).slice(ENC_PREFIX.length).split(':')
      .map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // A changed server secret cannot be recovered from; the tenant re-enters it.
    return '';
  }
}

/* ── Templates ────────────────────────────────────────────────────────────── */

function renderTemplate(text, vars = {}) {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => (
    vars[name] === undefined || vars[name] === null ? '' : String(vars[name])
  ));
}

/** Built-ins with any tenant override folded in. */
async function listTemplates(tenantId) {
  const overrides = await EmailTemplate.find({ tenant_id: tenantId }).lean();
  const byKey = Object.fromEntries(overrides.map((o) => [o.key, o]));
  return Object.entries(DEFAULT_TEMPLATES).map(([key, base]) => {
    const override = byKey[key];
    return {
      key,
      group: base.group,
      label: base.label,
      description: base.description,
      variables: base.variables,
      subject: override?.subject ?? base.subject,
      body: override?.body ?? base.body,
      enabled: override?.enabled ?? true,
      customised: !!override,
      default_subject: base.subject,
      default_body: base.body,
    };
  });
}

/** What to actually send for an event, or null when it is switched off. */
async function resolveTemplate(tenantId, key) {
  const base = DEFAULT_TEMPLATES[key];
  if (!base) return null;
  const override = await EmailTemplate.findOne({ tenant_id: tenantId, key }).lean();
  if (override && override.enabled === false) return null;
  return { subject: override?.subject || base.subject, body: override?.body || base.body };
}

/* ── Sending ──────────────────────────────────────────────────────────────── */

const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

/**
 * A JSON round trip over HTTPS.
 *
 * Hand-rolled rather than pulled in, exactly as smsService does for mNotify:
 * one POST and one GET is not worth a dependency, and this way the whole
 * request is visible at the point somebody has to debug it.
 */
function httpJson(url, { method = 'POST', headers = {}, body } = {}) {
  const https = require('https');
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method,
      timeout: 20000,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { /* some replies are empty */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });

    req.on('timeout', () => { req.destroy(new Error('The email service did not answer in time.')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** What the provider said went wrong, dug out of whatever shape it replied in. */
const providerMessage = (res, fallback) => res.body?.message
  || res.body?.error?.message
  || res.body?.error
  || (res.raw ? String(res.raw).slice(0, 300) : '')
  || fallback;

/** Which way out this tenant has chosen. */
const providerOf = (settings) => (settings?.provider === 'brevo' || settings?.provider === 'resend'
  ? settings.provider
  : 'smtp');

/**
 * Whether this tenant could send an email right now, and what is missing if not.
 * Used by the settings page, so "not set up" is a sentence rather than a guess.
 */
function readiness(settings) {
  const s = settings || {};
  const missing = [];
  if (!looksLikeEmail(s.from_email)) missing.push('the address email is sent from');

  if (providerOf(s) === 'smtp') {
    if (!s.smtp?.host) missing.push('the mail server');
    if (!s.smtp?.username) missing.push('the mailbox username');
    if (!s.smtp?.password) missing.push('the mailbox password');
  } else if (!s.api_key) {
    missing.push('the API key');
  }

  return {
    configured: missing.length === 0,
    enabled: s.enabled !== false,
    provider: providerOf(s),
    missing,
    verified_at: s.verified_at || null,
  };
}

/** The line a mail client shows in the From column. */
function fromAddress(settings, businessName) {
  const name = (settings.from_name || businessName || '').replace(/"/g, '');
  return name ? `"${name}" <${settings.from_email}>` : settings.from_email;
}

/**
 * Whether to speak TLS from the first byte, decided by the port rather than by
 * the switch.
 *
 * The two are not independent, and getting them crossed does not fail cleanly —
 * it hangs. Speaking TLS at 587, which expects a plain greeting first, leaves
 * both ends waiting for the other until the timeout, and all the person setting
 * it up sees is "connection timeout" on settings that look right.
 *
 * 465 is implicit TLS. 25, 587 and 2525 start plain and upgrade. Anything else
 * is unusual enough to take the switch at its word.
 */
function secureForPort(port, flag) {
  if (port === 465) return true;
  if (port === 25 || port === 587 || port === 2525) return false;
  return flag === true;
}

function buildTransport(settings, overrides = {}) {
  const smtp = settings.smtp || {};
  const port = Number(overrides.port ?? smtp.port) || 587;
  return nodemailer.createTransport({
    host: smtp.host,
    port,
    secure: secureForPort(port, overrides.secure ?? smtp.secure),
    auth: { user: smtp.username, pass: decryptSecret(smtp.password) },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

/* ── The three ways out ────────────────────────────────────────────────────
 *
 * Same shape from each: { sent, provider, provider_ref } or { sent: false,
 * reason }. Never report a send you are not sure of — the caller writes down
 * what happened and the business reads it later.
 */

const DISPATCH = {
  async smtp({ settings, businessName, to, subject, body }) {
    const info = await buildTransport(settings).sendMail({
      from: fromAddress(settings, businessName),
      to,
      ...(settings.reply_to ? { replyTo: settings.reply_to } : {}),
      subject: subject || '',
      text: body || '',
    });
    return { sent: true, provider: 'smtp', provider_ref: info?.messageId || null };
  },

  async brevo({ settings, businessName, to, subject, body }) {
    const res = await httpJson('https://api.brevo.com/v3/smtp/email', {
      headers: { 'api-key': decryptSecret(settings.api_key) },
      body: {
        sender: { name: settings.from_name || businessName || undefined, email: settings.from_email },
        to: [{ email: to }],
        ...(settings.reply_to ? { replyTo: { email: settings.reply_to } } : {}),
        subject: subject || '',
        textContent: body || '',
      },
    });
    if (res.status >= 200 && res.status < 300) {
      return { sent: true, provider: 'brevo', provider_ref: res.body?.messageId || null };
    }
    return { sent: false, provider: 'brevo', reason: providerMessage(res, 'Brevo refused the message.') };
  },

  async resend({ settings, businessName, to, subject, body }) {
    const res = await httpJson('https://api.resend.com/emails', {
      headers: { Authorization: `Bearer ${decryptSecret(settings.api_key)}` },
      body: {
        from: fromAddress(settings, businessName),
        to: [to],
        ...(settings.reply_to ? { reply_to: settings.reply_to } : {}),
        subject: subject || '',
        text: body || '',
      },
    });
    if (res.status >= 200 && res.status < 300) {
      return { sent: true, provider: 'resend', provider_ref: res.body?.id || null };
    }
    return { sent: false, provider: 'resend', reason: providerMessage(res, 'Resend refused the message.') };
  },
};

/** Prove the key or the mailbox, without sending anything. */
const CHECK = {
  async smtp(settings) {
    await buildTransport(settings).verify();
  },
  async brevo(settings) {
    const res = await httpJson('https://api.brevo.com/v3/account', {
      method: 'GET',
      headers: { 'api-key': decryptSecret(settings.api_key) },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(providerMessage(res, 'Brevo did not accept that API key.'));
    }
  },
  async resend(settings) {
    const res = await httpJson('https://api.resend.com/domains', {
      method: 'GET',
      headers: { Authorization: `Bearer ${decryptSecret(settings.api_key)}` },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(providerMessage(res, 'Resend did not accept that API key.'));
    }
  },
};

/**
 * Send one email as the tenant.
 *
 * Returns a result rather than throwing: an order must not fail to be recorded
 * because a mail server was slow. Every outcome is logged, refusals included,
 * so "did the customer get it" has an answer.
 */
async function sendEmail({ tenantId, to, subject, body, templateKey, source, userId, settings, tenant }) {
  const recipient = String(to || '').trim();
  const log = async (status, extra = {}) => EmailMessage.create({
    tenant_id: tenantId,
    to: recipient,
    subject: subject || '',
    body: body || '',
    template_key: templateKey,
    source,
    sent_by: userId || null,
    ...extra,
    status,
  }).catch(() => {});

  if (!looksLikeEmail(recipient)) return { sent: false, channel: 'email', reason: 'no_recipient' };
  if (!subject?.trim() && !body?.trim()) return { sent: false, channel: 'email', reason: 'empty_body' };

  const doc = tenant || await Tenant.findById(tenantId).select('email_settings business_name').lean();
  const conf = settings || doc?.email_settings || {};

  if (conf.enabled === false) {
    await log('disabled');
    return { sent: false, channel: 'email', reason: 'email_disabled' };
  }

  const state = readiness(conf);
  if (!state.configured) {
    await log('not_configured', { error: `Email is not set up: missing ${state.missing.join(', ')}.` });
    return { sent: false, channel: 'email', reason: 'not_configured', missing: state.missing };
  }

  const provider = providerOf(conf);

  try {
    const result = await DISPATCH[provider]({
      settings: conf,
      businessName: doc?.business_name,
      to: recipient,
      subject,
      body,
    });

    if (!result.sent) {
      await log('failed', { provider, error: result.reason });
      await Tenant.findByIdAndUpdate(tenantId, { 'email_settings.last_error': result.reason }).catch(() => {});
      return { sent: false, channel: 'email', reason: result.reason };
    }

    await log('sent', { provider, provider_ref: result.provider_ref });
    await Tenant.findByIdAndUpdate(tenantId, {
      'email_settings.verified_at': new Date(),
      'email_settings.last_error': '',
    }).catch(() => {});
    return { sent: true, channel: 'email', provider_ref: result.provider_ref };
  } catch (err) {
    const reason = friendlyError(err);
    await log('failed', { provider, error: reason });
    await Tenant.findByIdAndUpdate(tenantId, { 'email_settings.last_error': reason }).catch(() => {});
    return { sent: false, channel: 'email', reason };
  }
}

/**
 * Mail servers report failures in their own dialect. These are the four a
 * business will actually hit, said in words they can act on.
 */
function friendlyError(err) {
  const text = String(err?.message || err || '');
  if (/Invalid login|535|authentication failed/i.test(text)) {
    return 'The mail server rejected the username or password. '
      + 'If the mailbox has two-step verification, you need an app password rather than the everyday one.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'That mail server could not be found — check the host name.';
  if (/ECONNREFUSED|ETIMEDOUT|timed out|Connection timeout|Greeting never received/i.test(text)) {
    return 'Nothing answered on that port. Either the port is wrong — 587 for most mailboxes, '
      + '465 with TLS — or the server GEMS runs on is not allowed to send mail out. '
      + 'Hosting providers block that by default on their cheaper plans.';
  }
  if (/self.signed|certificate/i.test(text)) return 'The mail server’s security certificate could not be verified.';
  return text || 'The mail server refused the message.';
}

/** Send a templated email, skipping quietly when the tenant switched it off. */
async function sendTemplated({ tenantId, to, key, vars = {}, userId }) {
  const template = await resolveTemplate(tenantId, key);
  if (!template) return { sent: false, channel: 'email', reason: 'template_disabled' };

  const tenant = await Tenant.findById(tenantId).select('email_settings business_name').lean();
  const filled = { business_name: tenant?.business_name || '', ...vars };

  return sendEmail({
    tenantId,
    to,
    subject: renderTemplate(template.subject, filled),
    body: renderTemplate(template.body, filled),
    templateKey: key,
    source: key,
    userId,
    tenant,
  });
}

/**
 * Prove the mailbox works before anything real is sent through it.
 *
 * This opens a connection and signs in; it sends nothing. That is enough to
 * catch the usual four — wrong password, wrong host, wrong port, blocked — and
 * fails in a second rather than after a delivery attempt. Actually posting
 * something is a separate step, because a mailbox that authenticates can still
 * refuse to send.
 *
 * The raw text the server gave is handed back alongside the readable version:
 * the readable one is for the person setting this up, the raw one is what they
 * paste to whoever they end up asking.
 */
async function verifyConnection(settings) {
  const state = readiness(settings);
  if (!state.configured) {
    return { ok: false, reason: `Still missing ${state.missing.join(', ')}.`, detail: '' };
  }

  const provider = providerOf(settings);
  try {
    await CHECK[provider](settings);
    return { ok: true };
  } catch (err) {
    const detail = String(err?.message || err);

    // Ports are an SMTP problem. A key that is refused over HTTPS is refused,
    // and there is no second port to try.
    if (provider !== 'smtp') {
      return { ok: false, reason: detail, detail };
    }

    // A timeout has two causes that look identical from here: the wrong port,
    // or a host that will not let mail out at all. Trying the other port tells
    // them apart in ten seconds, which beats a week of guessing.
    if (/ETIMEDOUT|timed out|Connection timeout|Greeting never received/i.test(detail)) {
      const alternative = await tryOtherPort(settings);
      if (alternative) {
        return {
          ok: false,
          reason: `Port ${Number(settings.smtp?.port) || 587} did not answer, but ${alternative.port} `
            + `${alternative.secure ? 'with TLS on' : 'with TLS off'} did. Change the port to `
            + `${alternative.port}, turn TLS ${alternative.secure ? 'on' : 'off'}, and save.`,
          detail,
          suggestion: alternative,
        };
      }
      return {
        ok: false,
        reason: 'Neither 587 nor 465 answered. Either the mail server name is wrong, or the server '
          + 'GEMS runs on is not allowed to send mail out — hosting providers block that by default '
          + 'on their cheaper plans, and only they can unblock it.',
        detail,
      };
    }

    return { ok: false, reason: friendlyError(err), detail };
  }
}

/**
 * The other way round, in case that is the one this mailbox wants.
 *
 * Only reached after a timeout, and only tries the pairing that was not just
 * tried — there are two in practice, and a mailbox that answers on neither is
 * not a settings problem.
 */
async function tryOtherPort(settings) {
  const port = Number(settings.smtp?.port) || 587;
  const candidates = port === 465
    ? [{ port: 587, secure: false }]
    : [{ port: 465, secure: true }];

  for (const candidate of candidates) {
    try {
      await buildTransport(settings, candidate).verify();
      return candidate;
    } catch {
      // Expected: this is the guess, not the answer.
    }
  }
  return null;
}

module.exports = {
  DEFAULT_TEMPLATES,
  secureForPort,
  providerOf,
  TEMPLATE_VARIABLES,
  encryptSecret,
  decryptSecret,
  friendlyError,
  fromAddress,
  listTemplates,
  looksLikeEmail,
  readiness,
  renderTemplate,
  resolveTemplate,
  sendEmail,
  sendTemplated,
  verifyConnection,
};
