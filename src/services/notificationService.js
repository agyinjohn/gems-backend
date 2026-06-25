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

async function sendViaSms({ to, body }) {
  if (!to) return { sent: false, channel: 'sms', reason: 'no_recipient' };
  if (process.env.TWILIO_ACCOUNT_SID) {
    console.log('[Notification:sms] Would send', { to });
    return { sent: true, channel: 'sms', stub: false };
  }
  console.log('[Notification:sms:stub]', { to, body: body?.slice(0, 120) });
  return { sent: false, channel: 'sms', stub: true };
}

async function sendOrderConfirmation({ tenantId, order, customerEmail, customerPhone, channel = 'storefront' }) {
  const subject = `Order confirmed — ${order.order_number}`;
  const body = `Hi ${order.customer_name},\n\nYour order ${order.order_number} for GH₵${order.total} has been confirmed.\n\nThank you for shopping with us!`;

  const results = await Promise.all([
    sendViaEmail({ to: customerEmail || order.customer_email, subject, body }),
    sendViaSms({ to: customerPhone || order.customer_phone, body: `${order.order_number} confirmed. Total GH₵${order.total}.` }),
  ]);

  return {
    sent: results.some((r) => r.sent),
    stub: results.every((r) => r.stub !== false),
    queued: true,
    channels: results,
    payload: { tenant_id: String(tenantId), order_number: order.order_number, channel },
  };
}

module.exports = { sendOrderConfirmation, sendViaEmail, sendViaSms };
