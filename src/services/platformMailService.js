const nodemailer = require('nodemailer');

/**
 * Mail sent by the platform itself — verification and password-reset codes —
 * as opposed to the tenant's own mailbox, which belongs to emailService.
 */
let transporter;
const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.PLATFORM_GMAIL_USER,
        pass: (process.env.PLATFORM_GMAIL_APP_PASSWORD || '').replace(/\s/g, ''),
      },
    });
  }
  return transporter;
};

const configured = () => !!(process.env.PLATFORM_GMAIL_USER && process.env.PLATFORM_GMAIL_APP_PASSWORD);

/** Never throws: returns { sent, reason }. */
async function sendPlatformMail({ to, subject, text, html }) {
  if (!configured()) return { sent: false, reason: 'Missing Gmail credentials' };
  try {
    await getTransporter().sendMail({ from: `"GEMS" <${process.env.PLATFORM_GMAIL_USER}>`, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    console.error('[PLATFORM MAIL ERROR]', err.message);
    return { sent: false, reason: err.message };
  }
}

/** A code on its own line, in the house style. */
const codeEmail = ({ heading, intro, code, minutes }) => ({
  text: `${intro}\n\n${code}\n\nIt expires in ${minutes} minutes. Do not share it with anyone.`,
  html: `<div style="font-family:sans-serif;max-width:480px;margin:auto">
    <h2 style="color:#0D3B6E">${heading}</h2>
    <p>${intro}</p>
    <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#0D3B6E;padding:16px 0">${code}</div>
    <p style="color:#666">It expires in ${minutes} minutes. Do not share it with anyone.</p>
  </div>`,
});

module.exports = { sendPlatformMail, codeEmail, platformMailConfigured: configured };
