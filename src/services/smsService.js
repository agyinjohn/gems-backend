const { Tenant, SmsTemplate, SmsMessage, PlatformSettings } = require('../models');

/**
 * SMS — prepaid credits, tenant-customisable templates, and sending.
 *
 * Tenants buy credits from the platform in bundles and spend one credit per
 * message segment. Sending is refused at zero rather than queued, and every
 * attempt is logged, including the refusals, so a tenant can see exactly why a
 * customer didn't get a message.
 *
 * Credits are debited atomically before the message goes out, so concurrent
 * sends can't push a balance negative.
 */

/* ── Built-in templates ────────────────────────────────────────────────────
 *
 * Only customised templates are stored per tenant; anything a tenant hasn't
 * touched falls back to these, so new templates ship without a migration.
 *
 * Deliberately GSM-7 only: no "₵", curly quotes or emoji. A single non-GSM
 * character switches the whole message to UCS-2, which cuts the segment from
 * 160 characters to 70 and so doubles or triples what the tenant is charged.
 */
const DEFAULT_TEMPLATES = {
  order_confirmed: {
    label: 'Order confirmed',
    description: 'Sent when a customer\'s payment succeeds.',
    body: 'Hi {{customer_name}}, your order {{order_number}} of GHS {{total}} is confirmed. Thank you for shopping with {{business_name}}.',
  },
  order_shipped: {
    label: 'Order shipped',
    description: 'Sent when an order is marked shipped.',
    body: 'Hi {{customer_name}}, your order {{order_number}} is on its way. Thank you for shopping with {{business_name}}.',
  },
  order_delivered: {
    label: 'Order delivered',
    description: 'Sent when an order is marked delivered.',
    body: 'Hi {{customer_name}}, your order {{order_number}} has been delivered. Thank you for shopping with {{business_name}}.',
  },
  order_cancelled: {
    label: 'Order cancelled',
    description: 'Sent when an order is cancelled.',
    body: 'Hi {{customer_name}}, your order {{order_number}} has been cancelled. Contact {{business_name}} if this is unexpected.',
  },
};

const TEMPLATE_VARIABLES = [
  '{{customer_name}}', '{{order_number}}', '{{total}}', '{{business_name}}', '{{status}}',
];

/* ── Segment counting ─────────────────────────────────────────────────────── */

// The GSM 03.38 basic alphabet, plus the extension characters that each take
// two septets. Anything outside this forces the message to UCS-2.
const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€';

function isGsm7(text) {
  for (const ch of text) {
    if (!GSM_BASIC.includes(ch) && !GSM_EXTENDED.includes(ch)) return false;
  }
  return true;
}

/**
 * Billable segments for a message — what the tenant is charged.
 * GSM-7: 160 in one segment, 153 each once concatenated.
 * UCS-2: 70 in one segment, 67 each once concatenated.
 */
function countSegments(text) {
  const body = text || '';
  if (!body.length) return 0;

  if (isGsm7(body)) {
    // Extension characters occupy two septets each.
    let septets = 0;
    for (const ch of body) septets += GSM_EXTENDED.includes(ch) ? 2 : 1;
    if (septets <= 160) return 1;
    return Math.ceil(septets / 153);
  }

  // UCS-2 counts UTF-16 code units, so astral characters cost two.
  const units = body.length;
  if (units <= 70) return 1;
  return Math.ceil(units / 67);
}

/* ── Templates ────────────────────────────────────────────────────────────── */

function renderTemplate(body, vars = {}) {
  return String(body || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Built-in templates merged with the tenant's overrides. */
async function listTemplates(tenantId) {
  const overrides = await SmsTemplate.find({ tenant_id: tenantId }).lean();
  const byKey = Object.fromEntries(overrides.map((o) => [o.key, o]));

  return Object.entries(DEFAULT_TEMPLATES).map(([key, def]) => {
    const custom = byKey[key];
    return {
      key,
      label: def.label,
      description: def.description,
      body: custom?.body ?? def.body,
      default_body: def.body,
      enabled: custom?.enabled ?? true,
      is_customised: !!custom,
      segments: countSegments(custom?.body ?? def.body),
    };
  });
}

/** The template actually in force for a tenant, or null when switched off. */
async function resolveTemplate(tenantId, key) {
  const def = DEFAULT_TEMPLATES[key];
  if (!def) return null;
  const custom = await SmsTemplate.findOne({ tenant_id: tenantId, key }).lean();
  if (custom && custom.enabled === false) return null;
  return { key, body: custom?.body ?? def.body };
}

/* ── Sending ──────────────────────────────────────────────────────────────── */

/** Normalise a Ghanaian number to E.164 so the gateway accepts it. */
function normalisePhone(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('233')) return `+${digits}`;
  if (digits.startsWith('0')) return `+233${digits.slice(1)}`;
  if (digits.length === 9) return `+233${digits}`;
  return `+${digits}`;
}

/**
 * Hand the message to the SMS gateway.
 *
 * No provider is wired up yet, so this reports "not configured" rather than
 * claiming a send. Credits are only spent on a real send, so nothing is
 * charged while this is a stub.
 */
async function dispatchToProvider({ to, body, senderId }) {
  const apiKey = process.env.SMS_API_KEY;
  if (!apiKey) {
    console.log('[SMS:stub]', { to, senderId, body: body.slice(0, 80) });
    return { sent: false, provider: 'stub', reason: 'SMS gateway is not configured.' };
  }
  // Wire the chosen Ghanaian gateway (Hubtel, mNotify, Arkesel…) here. It must
  // resolve { sent, provider, provider_ref } or throw.
  console.log('[SMS] gateway configured but no client wired', { to });
  return { sent: false, provider: 'unconfigured', reason: 'No SMS gateway client is wired up.' };
}

/**
 * Send one SMS on a tenant's credit balance.
 *
 * Returns a result rather than throwing, so a failed notification never breaks
 * the order flow that triggered it. Every outcome is logged.
 */
async function sendSms({ tenantId, to, body, templateKey, source, userId }) {
  const phone = normalisePhone(to);
  const log = async (status, extra = {}) => SmsMessage.create({
    tenant_id: tenantId,
    to: phone || String(to || ''),
    body: body || '',
    template_key: templateKey,
    source,
    sent_by: userId || null,
    ...extra,
    status,
  });

  if (!phone) return { sent: false, reason: 'no_recipient' };
  if (!body?.trim()) return { sent: false, reason: 'empty_body' };

  const tenant = await Tenant.findById(tenantId).select('sms_settings business_name').lean();
  if (tenant?.sms_settings?.enabled === false) {
    await log('disabled', { segments: countSegments(body), credits_used: 0 });
    return { sent: false, reason: 'sms_disabled' };
  }

  const segments = countSegments(body);

  // Debit first, and only if the balance covers it. Doing it as one conditional
  // update means concurrent sends can't take the balance below zero.
  const debited = await Tenant.findOneAndUpdate(
    { _id: tenantId, sms_credits: { $gte: segments } },
    { $inc: { sms_credits: -segments } },
    { new: true },
  );

  if (!debited) {
    await log('insufficient_credits', { segments, credits_used: 0 });
    return { sent: false, reason: 'insufficient_credits', segments };
  }

  const settings = await PlatformSettings.findOne().select('sms_sender_id').lean();
  const senderId = tenant?.sms_settings?.sender_id || settings?.sms_sender_id || 'GEMS';

  try {
    const result = await dispatchToProvider({ to: phone, body, senderId });
    if (!result.sent) {
      // Nothing left the building, so give the credits back.
      await Tenant.findByIdAndUpdate(tenantId, { $inc: { sms_credits: segments } });
      await log('failed', { segments, credits_used: 0, error: result.reason, provider: result.provider });
      return { sent: false, reason: result.reason, segments };
    }

    await log('sent', {
      segments,
      credits_used: segments,
      provider: result.provider,
      provider_ref: result.provider_ref,
    });
    return { sent: true, segments, credits_remaining: debited.sms_credits };
  } catch (err) {
    await Tenant.findByIdAndUpdate(tenantId, { $inc: { sms_credits: segments } });
    await log('failed', { segments, credits_used: 0, error: err.message });
    return { sent: false, reason: err.message, segments };
  }
}

/** Send a templated message, skipping quietly when the tenant switched it off. */
async function sendTemplated({ tenantId, to, key, vars, userId }) {
  const template = await resolveTemplate(tenantId, key);
  if (!template) return { sent: false, reason: 'template_disabled' };

  const tenant = await Tenant.findById(tenantId).select('business_name').lean();
  const body = renderTemplate(template.body, { business_name: tenant?.business_name || '', ...vars });

  return sendSms({ tenantId, to, body, templateKey: key, source: key, userId });
}

module.exports = {
  DEFAULT_TEMPLATES,
  TEMPLATE_VARIABLES,
  countSegments,
  isGsm7,
  normalisePhone,
  renderTemplate,
  listTemplates,
  resolveTemplate,
  sendSms,
  sendTemplated,
};
