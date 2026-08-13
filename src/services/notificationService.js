/**
 * Notification service — one event, whichever channels the tenant has set up.
 *
 * Both channels belong to the tenant rather than the platform: SMS spends their
 * prepaid credits and goes out under their sender ID, email goes through their
 * own mailbox. Neither ever throws — a customer not getting a message must not
 * take down the order that triggered it.
 */

async function sendViaEmail({ tenantId, to, subject, body, templateKey, source, userId }) {
  if (!to) return { sent: false, channel: 'email', reason: 'no_recipient' };
  if (!tenantId) return { sent: false, channel: 'email', reason: 'no_tenant' };
  const { sendEmail } = require('./emailService');
  return sendEmail({ tenantId, to, subject, body, templateKey, source, userId });
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
  const { sendTemplated: smsTemplated } = require('./smsService');
  const { sendTemplated: emailTemplated } = require('./emailService');

  // One set of variables, two channels, each with its own wording. The business
  // edits both on the same page and either can be switched off on its own.
  const vars = {
    customer_name: order.customer_name,
    order_number: order.order_number,
    total: Number(order.total || 0).toFixed(2),
    status: key.replace('order_', ''),
  };

  const results = await Promise.all([
    emailTemplated({ tenantId, to: customerEmail || order.customer_email, key, vars })
      .catch((err) => ({ sent: false, channel: 'email', reason: err.message })),
    smsTemplated({ tenantId, to: customerPhone || order.customer_phone, key, vars })
      .then((r) => ({ ...r, channel: 'sms' }))
      .catch((err) => ({ sent: false, channel: 'sms', reason: err.message })),
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

/**
 * Text the client who awarded a contract.
 *
 * Silent by default and silent on every failure. These fire from inside
 * invoicing and progress updates, so anything thrown here would take down the
 * thing the user was actually doing — raising an application must not fail
 * because a phone number was mistyped.
 *
 * Three gates, all of which have to open: client updates switched on for this
 * particular job, a number to send to, and the tenant not having turned the
 * template off. Nothing here spends a credit that somebody didn't ask to spend.
 */
async function sendProjectNotification({ tenantId, project, key, vars = {}, userId }) {
  try {
    if (!project?.client_sms_enabled) return { sent: false, reason: 'client_sms_off' };

    let phone = project.client_phone;
    if (!phone && project.customer_id) {
      const { Customer } = require('../models');
      const customer = await Customer.findOne({ _id: project.customer_id, tenant_id: tenantId })
        .select('phone').lean();
      phone = customer?.phone;
    }
    if (!phone) return { sent: false, reason: 'no_recipient' };

    const { sendTemplated } = require('./smsService');
    return sendTemplated({
      tenantId,
      to: phone,
      key,
      userId,
      vars: {
        customer_name: project.customer_name || 'there',
        project_name: project.name,
        project_code: project.code,
        ...vars,
      },
    });
  } catch (err) {
    // Logged rather than raised — see above.
    console.error('[Notification:project]', key, err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = {
  sendOrderConfirmation,
  sendOrderNotification,
  sendProjectNotification,
  sendViaEmail,
  sendViaSms,
};
