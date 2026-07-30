/**
 * Notification service — email/SMS channels with provider stubs.
 * Wire SENDGRID_API_KEY, TWILIO_* etc. in production.
 */

async function sendViaEmail({ to, subject, body }) {
  if (!to) return { sent: false, channel: 'email', reason: 'no_recipient' };
  if (process.env.SENDGRID_API_KEY || process.env.SMTP_HOST) {
    console.log('[Notification:email] Would send', { to, subject });
    return { sent: true, channel: 'email', stub: !process.env.SENDGRID_API_KEY };
  }
  console.log('[Notification:email:stub]', { to, subject, body: body?.slice(0, 120) });
  return { sent: false, channel: 'email', stub: true };
}

/**
 * SMS goes through smsService, which spends the tenant's prepaid credits and
 * uses their own (customisable) template. A tenant with no credits simply
 * doesn't get a message sent — the attempt is logged and the caller carries on.
 */
async function sendViaSms({ tenantId, to, body, templateKey, source }) {
  if (!to) return { sent: false, channel: 'sms', reason: 'no_recipient' };
  if (!tenantId) return { sent: false, channel: 'sms', reason: 'no_tenant' };
  const { sendSms } = require('./smsService');
  const result = await sendSms({ tenantId, to, body, templateKey, source });
  return { ...result, channel: 'sms' };
}

/** Notify a customer about an order, on whichever channels are available. */
async function sendOrderNotification({ tenantId, order, key, customerEmail, customerPhone, channel = 'storefront' }) {
  const { sendTemplated } = require('./smsService');

  const subject = `Order ${key.replace('order_', '')} — ${order.order_number}`;
  const emailBody = `Hi ${order.customer_name},\n\nYour order ${order.order_number} for GHS ${order.total} has been ${key.replace('order_', '')}.\n\nThank you!`;

  const results = await Promise.all([
    sendViaEmail({ to: customerEmail || order.customer_email, subject, body: emailBody }),
    sendTemplated({
      tenantId,
      to: customerPhone || order.customer_phone,
      key,
      vars: {
        customer_name: order.customer_name,
        order_number: order.order_number,
        total: Number(order.total || 0).toFixed(2),
        status: key.replace('order_', ''),
      },
    }).then((r) => ({ ...r, channel: 'sms' })),
  ]);

  return {
    sent: results.some((r) => r.sent),
    queued: true,
    channels: results,
    payload: { tenant_id: String(tenantId), order_number: order.order_number, channel },
  };
}

async function sendOrderConfirmation({ tenantId, order, customerEmail, customerPhone, channel = 'storefront' }) {
  return sendOrderNotification({ tenantId, order, key: 'order_confirmed', customerEmail, customerPhone, channel });
}

module.exports = { sendOrderConfirmation, sendOrderNotification, sendViaEmail, sendViaSms };
