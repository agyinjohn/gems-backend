const rateLimit = require('express-rate-limit');

/**
 * Throttles for the endpoints a stranger can reach, and for the ones that cost
 * money (every text message is a credit) or open a door (login, reset).
 *
 * Where the client address is the key, it is only as trustworthy as the proxy
 * setting in server.js — so the sensitive ones also key on the account or the
 * target (see `byEmail`), and sign-in has a per-account lockout besides.
 * Turn a limit off for local development with RATE_LIMIT_DISABLED=true.
 */
const disabled = () => process.env.RATE_LIMIT_DISABLED === 'true';

const tooMany = (message) => (req, res) => res.status(429).json({ success: false, message });

const make = ({ windowMs, max, message, key, skipSuccessfulRequests = false }) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests,
  skip: disabled,
  keyGenerator: key,
  handler: tooMany(message),
  // Proxy handling is configured once, in server.js.
  validate: { trustProxy: false, xForwardedForHeader: false },
});

const ip = (req) => req.ip || 'unknown';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** The caller plus whoever they say they are, so one shared address can't lock out everyone. */
const byEmail = (req) => `${ip(req)}|${String(req.body?.email || req.body?.phone || '').toLowerCase().trim().slice(0, 120)}`;

module.exports = {
  // Everything under /api, generous: stops a runaway script, not a busy till.
  api: make({ windowMs: MIN, max: 600, key: ip, message: 'Too many requests. Please slow down and try again shortly.' }),

  login: make({ windowMs: 15 * MIN, max: 10, key: byEmail, skipSuccessfulRequests: true,
    message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' }),

  // A code sent by SMS or email costs a credit and reaches a stranger's phone.
  sendCode: make({ windowMs: HOUR, max: 10, key: ip,
    message: 'Too many verification codes requested. Please try again in an hour.' }),
  // Two-factor codes by text or email, per account (signed in, or mid sign-in),
  // so a busy office behind one address is not throttled as one person.
  twoFactorCode: make({ windowMs: HOUR, max: 10,
    key: (req) => `${ip(req)}|${req.user?._id || String(req.body?.challenge_token || '').slice(-24)}`,
    message: 'Too many codes requested. Please try again in an hour, or use a recovery code.' }),
  verifyCode: make({ windowMs: 15 * MIN, max: 20, key: byEmail,
    message: 'Too many attempts. Please wait a few minutes and request a new code.' }),

  forgotPassword: make({ windowMs: HOUR, max: 5, key: byEmail,
    message: 'Too many reset requests. Please try again in an hour.' }),
  resetPassword: make({ windowMs: 15 * MIN, max: 10, key: byEmail,
    message: 'Too many attempts. Please wait a few minutes and request a new code.' }),

  register: make({ windowMs: HOUR, max: 10, key: ip,
    message: 'Too many sign-ups from this connection. Please try again later.' }),

  // Shoppers on a storefront.
  storeAuth: make({ windowMs: 15 * MIN, max: 15, key: byEmail, skipSuccessfulRequests: true,
    message: 'Too many attempts. Please wait a few minutes and try again.' }),

  // Anonymous submissions with files.
  publicSubmit: make({ windowMs: HOUR, max: 20, key: ip,
    message: 'Too many submissions from this connection. Please try again later.' }),
};
