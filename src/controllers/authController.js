const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { User, Tenant, Branch, Product, Employee, PlatformSettings, AuditLog } = require('../models');
const audit = require('../utils/audit');
const { passwordProblem } = require('../utils/passwordPolicy');
const { generateSecret, verifyTotp, otpauthUrl } = require('../utils/totp');
const secretBox = require('../utils/secretBox');
const { sendPlatformMail, codeEmail } = require('../services/platformMailService');
const sms = require('../services/smsService');

/**
 * What this business actually sells.
 *
 * The app has one counter for taking money over the table, and calling it a
 * point of sale is wrong for a firm that has never sold a thing off a shelf —
 * what happens there is billing a client for work. Read from the catalogue
 * rather than asked at sign-up, because it changes: a printer that starts
 * stocking paper becomes both without anyone updating a setting.
 */
async function catalogMix(tenantId) {
  const [goods, work] = await Promise.all([
    // Rows written before item_type existed are products, which is what the
    // column defaults to.
    Product.countDocuments({ tenant_id: tenantId, is_active: true, item_type: { $nin: ['service', 'bundle'] } }),
    Product.countDocuments({ tenant_id: tenantId, is_active: true, item_type: { $in: ['service', 'bundle'] } }),
  ]);
  if (goods && work) return 'both';
  if (work) return 'services';
  if (goods) return 'products';
  return 'empty';
}

/** The slice of the tenant record the app is given on the way in. */
async function tenantPayload(tenant) {
  return {
    id: tenant._id,
    business_name: tenant.business_name,
    slug: tenant.slug,
    plan: tenant.plan,
    subscription_status: tenant.subscription_status,
    subscription_expires_at: tenant.subscription_expires_at,
    removed_features: tenant.removed_features || [],
    sells: await catalogMix(tenant._id),
  };
}

// A session lasts a working day by default; JWT_EXPIRES_IN overrides it.
const generateToken = (user) =>
  jwt.sign(
    { id: user._id, email: user.email, role: user.role, tenant_id: user.tenant_id, branch_id: user.branch_id, tv: user.token_version || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
  );

// The pass between "password accepted" and "second factor entered". Signed with
// a different key, so it can never be mistaken for a session token.
const challengeKey = () => `${process.env.JWT_SECRET}:2fa-challenge`;
const makeChallenge = (user) => jwt.sign({ id: String(user._id) }, challengeKey(), { expiresIn: '5m' });

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
// Compared against when the email is unknown, so "no such user" takes as long
// as "wrong password" and cannot be told apart by timing.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const minutesLeft = (until) => Math.max(1, Math.ceil((new Date(until).getTime() - Date.now()) / 60000));
const lockedMessage = (user) => `Too many failed attempts. This account is locked for ${minutesLeft(user.locked_until)} more minute${minutesLeft(user.locked_until) === 1 ? '' : 's'}.`;
const isLocked = (user) => !!user.locked_until && new Date(user.locked_until) > new Date();

/** Count a wrong password (or wrong second-factor code), locking the account at the limit. */
async function recordFailure(req, user, what = 'password') {
  const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { failed_login_attempts: 1 } }, { new: true });
  let locked = false;
  if (updated && updated.failed_login_attempts >= LOCK_AFTER) {
    await User.updateOne({ _id: user._id }, { $set: { locked_until: new Date(Date.now() + LOCK_MINUTES * 60000), failed_login_attempts: 0 } });
    locked = true;
  }
  req.user = user; req.tenant_id = user.tenant_id;
  await audit(req, 'LOGIN_FAILED', 'auth', `Wrong ${what} for ${user.email}${locked ? ' — account locked' : ''}`, { email: user.email }, 'failed');
  return locked;
}

/** The shape the app is given once someone is fully signed in. */
async function finishLogin(req, res, user) {
  let tenantData = null;
  let branchData = null;
  if (user.tenant_id) {
    const tenant = await Tenant.findById(user.tenant_id);
    if (!tenant || !tenant.is_active) return res.status(403).json({ success: false, message: 'Your business account is inactive.' });
    tenantData = await tenantPayload(tenant);
    const branch = await Branch.findById(user.branch_id);
    if (branch) branchData = { id: branch._id, name: branch.name, slug: branch.slug };
  }

  await User.updateOne({ _id: user._id }, { $set: { failed_login_attempts: 0, last_login_at: new Date() }, $unset: { locked_until: '' } });

  const token = generateToken(user);
  const {
    password_hash, twofa_secret, twofa_pending_secret, twofa_recovery, twofa_last_step,
    twofa_phone, twofa_pending_method, twofa_pending_phone,
    twofa_otp_hash, twofa_otp_expires, twofa_otp_attempts, twofa_otp_sent_at,
    reset_code_hash, reset_expires, reset_attempts, reset_sent_at, ...userObj
  } = user.toObject();
  // Include permissions in user object for frontend sidebar rendering
  const permissions = user.role === 'custom' ? (user.custom_role_id?.permissions || []) : [];
  req.user = user; req.tenant_id = user.tenant_id;
  await audit(req, 'LOGIN', 'auth', `${user.name} logged in`, { role: user.role });
  return res.json({ success: true, message: 'Login successful', data: { token, user: { ...userObj, id: user._id, permissions }, tenant: tenantData, branch: branchData } });
}

/* ── Codes sent by text or email ──────────────────────────────────────────── */

const OTP_MINUTES = 10;
const OTP_MAX_TRIES = 5;
const OTP_RESEND_SECONDS = 30;
const otpHash = (code) => crypto.createHash('sha256').update(String(code).trim()).digest('hex');
const METHOD_LABEL = { totp: 'authenticator app', sms: 'text message', email: 'email' };

/** "024•••••67" / "jo•••@gmail.com" — enough to recognise, not enough to use. */
function maskDestination(method, value) {
  if (!value) return '';
  if (method === 'email') {
    const [name, domain] = String(value).split('@');
    return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`;
  }
  const v = String(value);
  return `${v.slice(0, 4)}${'•'.repeat(Math.max(1, v.length - 6))}${v.slice(-2)}`;
}

/** A phone we can text: +<country><number>, 9 to 15 digits. */
function cleanPhone(raw) {
  const phone = sms.normalisePhone(raw);
  return phone && /^\+\d{9,15}$/.test(phone) ? phone : null;
}

/**
 * Make a fresh code, keep its hash on the user and send it by text or email.
 * Resolves { sent, reason, wait } — wait is set (seconds) when asked again too soon.
 */
async function sendOtp(user, method, phone, purpose = 'sign in') {
  const current = await User.findById(user._id).select('+twofa_otp_sent_at');
  const since = current?.twofa_otp_sent_at ? Date.now() - new Date(current.twofa_otp_sent_at).getTime() : Infinity;
  if (since < OTP_RESEND_SECONDS * 1000) return { sent: false, wait: Math.ceil((OTP_RESEND_SECONDS * 1000 - since) / 1000) };

  const code = crypto.randomInt(100000, 1000000).toString();
  await User.updateOne({ _id: user._id }, {
    $set: { twofa_otp_hash: otpHash(code), twofa_otp_expires: new Date(Date.now() + OTP_MINUTES * 60000), twofa_otp_attempts: 0, twofa_otp_sent_at: new Date() },
  });

  let result;
  if (method === 'email') {
    const mail = codeEmail({ heading: 'Your GEMS sign-in code', intro: `Use this code to ${purpose}:`, code, minutes: OTP_MINUTES });
    result = await sendPlatformMail({ to: user.email, subject: `${code} is your GEMS code`, ...mail });
  } else {
    const settings = await PlatformSettings.findOne().select('sms_sender_id').lean();
    result = await sms.dispatchToProvider({
      to: phone,
      body: `${code} is your GEMS code to ${purpose}. It expires in ${OTP_MINUTES} minutes. Never share it.`,
      senderId: settings?.sms_sender_id || 'GEMS',
    });
  }
  if (!result.sent) {
    console.error(`[2FA] could not send the ${method} code for`, user.email, result.reason);
    // Only in development, where there may be no gateway: print it.
    if (process.env.NODE_ENV !== 'production') console.log(`[2FA DEV] ${user.email} -> ${code}`);
  }
  return { sent: !!result.sent, reason: result.reason };
}

/** Check a sent code. Each code works once and dies after a few wrong tries. */
async function checkOtp(userId, code) {
  const user = await User.findById(userId).select('+twofa_otp_hash +twofa_otp_expires +twofa_otp_attempts');
  if (!user?.twofa_otp_hash || !user.twofa_otp_expires || !code) return false;
  if (new Date(user.twofa_otp_expires) < new Date() || (user.twofa_otp_attempts || 0) >= OTP_MAX_TRIES) {
    await User.updateOne({ _id: userId }, { $unset: { twofa_otp_hash: '', twofa_otp_expires: '' } });
    return false;
  }
  const given = Buffer.from(otpHash(code));
  const stored = Buffer.from(user.twofa_otp_hash);
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
    await User.updateOne({ _id: userId }, { $inc: { twofa_otp_attempts: 1 } });
    return false;
  }
  await User.updateOne({ _id: userId }, { $unset: { twofa_otp_hash: '', twofa_otp_expires: '' }, $set: { twofa_otp_attempts: 0 } });
  return true;
}

const sendFailedMessage = (method) => method === 'sms'
  ? 'We could not send the text message. Try again shortly, or use a recovery code.'
  : 'We could not send the email. Try again shortly, or use a recovery code.';

const login = async (req, res) => {
  const { email, password } = req.body;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }
  const user = await User.findOne({ email: email.toLowerCase().trim(), is_active: true })
    .populate('custom_role_id', 'name permissions is_active');
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }
  if (isLocked(user)) return res.status(429).json({ success: false, message: lockedMessage(user) });

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    const locked = await recordFailure(req, user);
    return locked
      ? res.status(429).json({ success: false, message: `Too many failed attempts. This account is locked for ${LOCK_MINUTES} minutes.` })
      : res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }

  // Right password. With two-factor on, that is only the first half.
  if (user.twofa_enabled) return startChallenge(res, user);
  return finishLogin(req, res, user);
};

/** Answer a correct password on a two-factor account: send the code if it is sent, hand back the pass. */
async function startChallenge(res, user) {
  const method = user.twofa_method || 'totp';
  const data = { challenge_token: makeChallenge(user), method };
  if (method === 'totp') {
    return res.json({ success: true, two_factor_required: true, message: 'Enter the code from your authenticator app.', data });
  }
  const full = await User.findById(user._id).select('+twofa_phone');
  const destination = method === 'sms' ? full?.twofa_phone : user.email;
  data.destination = maskDestination(method, destination);
  const sent = await sendOtp(user, method, destination);
  data.resend_in = OTP_RESEND_SECONDS;
  // A code sent moments ago is still good, so a quick second sign-in just reuses it.
  if (!sent.sent && !sent.wait) data.send_failed = true;
  return res.json({
    success: true, two_factor_required: true, data,
    message: data.send_failed ? sendFailedMessage(method) : `We sent a code by ${METHOD_LABEL[method]} to ${data.destination}.`,
  });
}

const challengeUser = (token) => {
  try { return jwt.verify(token, challengeKey()).id; } catch { return null; }
};

/** Send the sign-in code again (text or email methods only). */
const resendTwoFactor = async (req, res) => {
  const id = typeof req.body.challenge_token === 'string' && challengeUser(req.body.challenge_token);
  if (!id) return res.status(401).json({ success: false, message: 'That sign-in has expired. Please sign in again.' });
  const user = await User.findOne({ _id: id, is_active: true }).select('+twofa_phone');
  if (!user || !user.twofa_enabled) return res.status(401).json({ success: false, message: 'Please sign in again.' });
  if (user.twofa_method === 'totp') return res.status(400).json({ success: false, message: 'Your code comes from your authenticator app.' });
  const destination = user.twofa_method === 'sms' ? user.twofa_phone : user.email;
  const sent = await sendOtp(user, user.twofa_method, destination);
  if (sent.wait) return res.status(429).json({ success: false, message: `Please wait ${sent.wait} seconds before asking again.`, data: { resend_in: sent.wait } });
  if (!sent.sent) return res.status(502).json({ success: false, message: sendFailedMessage(user.twofa_method) });
  res.json({ success: true, message: `A new code is on its way to ${maskDestination(user.twofa_method, destination)}.`, data: { resend_in: OTP_RESEND_SECONDS } });
};

/** Second step of sign-in: the code (from the app, a text or an email), or one of the saved recovery codes. */
const verifyTwoFactor = async (req, res) => {
  const { challenge_token, code, recovery_code } = req.body;
  if (typeof challenge_token !== 'string' || (!code && !recovery_code)) {
    return res.status(400).json({ success: false, message: 'Enter your 6-digit code.' });
  }
  const id = challengeUser(challenge_token);
  if (!id) return res.status(401).json({ success: false, message: 'That sign-in has expired. Please sign in again.' });

  const user = await User.findOne({ _id: id, is_active: true })
    .select('+twofa_secret +twofa_last_step +twofa_recovery')
    .populate('custom_role_id', 'name permissions is_active');
  if (!user || !user.twofa_enabled) return res.status(401).json({ success: false, message: 'Please sign in again.' });
  if (isLocked(user)) return res.status(429).json({ success: false, message: lockedMessage(user) });

  let ok = false;
  if (recovery_code) {
    const hash = crypto.createHash('sha256').update(String(recovery_code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
    if ((user.twofa_recovery || []).includes(hash)) {
      ok = true;
      // Each recovery code works once.
      await User.updateOne({ _id: user._id }, { $pull: { twofa_recovery: hash } });
    }
  } else if ((user.twofa_method || 'totp') === 'totp') {
    const step = verifyTotp(secretBox.decrypt(user.twofa_secret), code);
    // A code already used cannot be used again, even inside its 30 seconds.
    if (step !== null && step > (user.twofa_last_step || 0)) {
      ok = true;
      await User.updateOne({ _id: user._id }, { $set: { twofa_last_step: step } });
    }
  } else {
    ok = await checkOtp(user._id, code);
  }
  if (!ok) {
    const locked = await recordFailure(req, user, 'two-factor code');
    const hint = user.twofa_method === 'totp' || !user.twofa_method
      ? 'That code is not right. Check the time on your phone and try again.'
      : 'That code is not right or has expired. Ask for a new one.';
    return res.status(locked ? 429 : 401).json({ success: false, message: locked ? `Too many failed attempts. This account is locked for ${LOCK_MINUTES} minutes.` : hint });
  }
  return finishLogin(req, res, user);
};

/* ── Two-factor setup (signed-in) ─────────────────────────────────────────── */

/**
 * Start turning on two-factor sign-in with the chosen method.
 *   totp  → a new key to scan into an authenticator app
 *   sms   → a code texted to `phone`
 *   email → a code sent to the account's email
 * Nothing changes until the code is entered at /2fa/enable.
 */
const setupTwoFactor = async (req, res) => {
  if (req.user.twofa_enabled) return res.status(400).json({ success: false, message: 'Two-factor sign-in is already on. Turn it off first to change the method.' });
  const method = req.body?.method || 'totp';
  if (!METHOD_LABEL[method]) return res.status(400).json({ success: false, message: 'Choose an authenticator app, text message or email.' });

  if (method === 'totp') {
    const secret = generateSecret();
    await User.updateOne({ _id: req.user._id }, { $set: { twofa_pending_secret: secretBox.encrypt(secret), twofa_pending_method: 'totp' }, $unset: { twofa_pending_phone: '' } });
    return res.json({ success: true, data: { method, secret, otpauth_url: otpauthUrl({ secret, account: req.user.email }) } });
  }

  let phone;
  if (method === 'sms') {
    phone = cleanPhone(req.body.phone);
    if (!phone) return res.status(400).json({ success: false, message: 'Enter a valid phone number, for example 024 123 4567.' });
  }
  await User.updateOne({ _id: req.user._id }, { $set: { twofa_pending_method: method, ...(phone && { twofa_pending_phone: phone }) }, $unset: { twofa_pending_secret: '', ...(!phone && { twofa_pending_phone: '' }) } });
  const sent = await sendOtp(req.user, method, phone, 'turn on two-factor sign-in');
  const destination = maskDestination(method, method === 'sms' ? phone : req.user.email);
  if (sent.wait) return res.status(429).json({ success: false, message: `Please wait ${sent.wait} seconds before asking for another code.`, data: { resend_in: sent.wait } });
  if (!sent.sent) {
    return res.status(502).json({ success: false, message: method === 'sms' ? 'We could not send the text message. Check the number or try again shortly.' : 'We could not send the email. Try again shortly.' });
  }
  res.json({ success: true, message: `We sent a code to ${destination}.`, data: { method, destination, resend_in: OTP_RESEND_SECONDS } });
};

const newRecoveryCodes = () => {
  const codes = Array.from({ length: 10 }, () => {
    const raw = crypto.randomBytes(8).toString('hex').toUpperCase().slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const hashes = codes.map((c) => crypto.createHash('sha256').update(c.replace('-', '')).digest('hex'));
  return { codes, hashes };
};

const enableTwoFactor = async (req, res) => {
  const user = await User.findById(req.user._id).select('+twofa_pending_secret +twofa_pending_method +twofa_pending_phone');
  // Setups started before methods existed only left a pending key behind.
  const method = user?.twofa_pending_method || (user?.twofa_pending_secret ? 'totp' : null);
  if (!method) return res.status(400).json({ success: false, message: 'Start the setup first.' });

  const set = { twofa_enabled: true, twofa_method: method };
  if (method === 'totp') {
    if (!user.twofa_pending_secret) return res.status(400).json({ success: false, message: 'Start the setup first.' });
    const step = verifyTotp(secretBox.decrypt(user.twofa_pending_secret), req.body.code);
    if (step === null) return res.status(400).json({ success: false, message: 'That code is not right. Check the time on your phone and try again.' });
    Object.assign(set, { twofa_secret: user.twofa_pending_secret, twofa_last_step: step });
  } else {
    if (!(await checkOtp(user._id, req.body.code))) return res.status(400).json({ success: false, message: 'That code is not right or has expired. Ask for a new one.' });
    if (method === 'sms') set.twofa_phone = user.twofa_pending_phone;
  }

  const { codes, hashes } = newRecoveryCodes();
  set.twofa_recovery = hashes;
  const unset = { twofa_pending_secret: '', twofa_pending_method: '', twofa_pending_phone: '' };
  if (method !== 'totp') unset.twofa_secret = '';
  if (method !== 'sms') unset.twofa_phone = '';
  await User.updateOne({ _id: user._id }, { $set: set, $unset: unset });
  await audit(req, 'TWO_FACTOR_ON', 'auth', `${req.user.name} turned on two-factor sign-in (${METHOD_LABEL[method]})`, { method });
  res.json({ success: true, message: 'Two-factor sign-in is on.', data: { method, recovery_codes: codes } });
};

/** Signed in, two-factor by text or email: send a code so the user can prove it is them (e.g. to turn it off). */
const sendTwoFactorCode = async (req, res) => {
  const user = await User.findById(req.user._id).select('+twofa_phone');
  if (!user.twofa_enabled || user.twofa_method === 'totp') return res.status(400).json({ success: false, message: 'Your code comes from your authenticator app.' });
  const destination = user.twofa_method === 'sms' ? user.twofa_phone : user.email;
  const sent = await sendOtp(user, user.twofa_method, destination, 'confirm it is you');
  if (sent.wait) return res.status(429).json({ success: false, message: `Please wait ${sent.wait} seconds before asking again.`, data: { resend_in: sent.wait } });
  if (!sent.sent) return res.status(502).json({ success: false, message: sendFailedMessage(user.twofa_method) });
  res.json({ success: true, message: `We sent a code to ${maskDestination(user.twofa_method, destination)}.`, data: { resend_in: OTP_RESEND_SECONDS } });
};

const disableTwoFactor = async (req, res) => {
  const { password, code, recovery_code } = req.body;
  const user = await User.findById(req.user._id).select('+twofa_secret +twofa_last_step +twofa_recovery');
  if (!user.twofa_enabled) return res.status(400).json({ success: false, message: 'Two-factor sign-in is not on.' });
  if (typeof password !== 'string' || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(400).json({ success: false, message: 'Your password is not right.' });
  }
  let ok = false;
  if (recovery_code) {
    const hash = crypto.createHash('sha256').update(String(recovery_code).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
    ok = (user.twofa_recovery || []).includes(hash);
  } else if ((user.twofa_method || 'totp') === 'totp') {
    ok = verifyTotp(secretBox.decrypt(user.twofa_secret), code) !== null;
  } else {
    ok = await checkOtp(user._id, code);
  }
  if (!ok) return res.status(400).json({ success: false, message: 'That code is not right.' });
  await User.updateOne({ _id: user._id }, {
    $set: { twofa_enabled: false, twofa_recovery: [], twofa_method: 'totp' },
    $unset: { twofa_secret: '', twofa_pending_secret: '', twofa_phone: '', twofa_pending_method: '', twofa_pending_phone: '', twofa_otp_hash: '', twofa_otp_expires: '' },
  });
  await audit(req, 'TWO_FACTOR_OFF', 'auth', `${req.user.name} turned off two-factor sign-in`);
  res.json({ success: true, message: 'Two-factor sign-in is off.' });
};

/** What the security page shows: the method in use, where codes go, and a phone to suggest. */
const twoFactorStatus = async (req, res) => {
  const user = await User.findById(req.user._id).select('+twofa_phone +twofa_recovery');
  let suggestedPhone = null;
  if (!user.twofa_enabled && req.user.tenant_id) {
    const employee = await Employee.findOne({ tenant_id: req.user.tenant_id, user_id: req.user._id }).select('phone').lean();
    suggestedPhone = employee?.phone || null;
    if (!suggestedPhone && req.user.role === 'business_owner') {
      const tenant = await Tenant.findById(req.user.tenant_id).select('phone').lean();
      suggestedPhone = tenant?.phone || null;
    }
  }
  res.json({ success: true, data: {
    enabled: !!user.twofa_enabled,
    method: user.twofa_enabled ? (user.twofa_method || 'totp') : null,
    destination: user.twofa_enabled && user.twofa_method !== 'totp'
      ? maskDestination(user.twofa_method, user.twofa_method === 'sms' ? user.twofa_phone : user.email) : null,
    recovery_left: user.twofa_enabled ? (user.twofa_recovery || []).length : 0,
    email: user.email,
    suggested_phone: suggestedPhone,
    last_login_at: user.last_login_at || null,
  } });
};

/** The signed-in user's own recent sign-ins and security changes. */
const myActivity = async (req, res) => {
  const rows = await AuditLog.find({ user_id: req.user._id, module: 'auth' })
    .sort({ createdAt: -1 }).limit(15)
    .select('action description device ip status createdAt').lean();
  res.json({ success: true, data: rows });
};

/** Sign out everywhere: every token issued so far stops working. */
const logoutEverywhere = async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $inc: { token_version: 1 } });
  await audit(req, 'LOGOUT_ALL', 'auth', `${req.user.name} signed out of all devices`);
  res.json({ success: true, message: 'Signed out of all devices.' });
};

const getMe = async (req, res) => {
  let tenantData = null;
  let branchData = null;
  if (req.user.tenant_id) {
    const tenant = await Tenant.findById(req.user.tenant_id);
    if (tenant) tenantData = await tenantPayload(tenant);
  }
  if (req.user.branch_id) {
    const branch = await Branch.findById(req.user.branch_id);
    if (branch) branchData = { id: branch._id, name: branch.name, slug: branch.slug };
  }
  // Same shape as login, so the app can refresh a user whose role was changed
  // without them signing out.
  const permissions = req.user.role === 'custom' ? (req.user.custom_role_id?.permissions || []) : [];
  const user = { ...req.user.toObject(), id: req.user._id, permissions };
  res.json({ success: true, data: { user, tenant: tenantData, branch: branchData } });
};

const changePassword = async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ success: false, message: 'Both passwords are required.' });
  const problem = passwordProblem(new_password);
  if (problem) return res.status(400).json({ success: false, message: problem });
  const user = await User.findById(req.user._id);
  const isMatch = await bcrypt.compare(current_password, user.password_hash);
  if (!isMatch) return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
  user.password_hash = await bcrypt.hash(new_password, 10);
  user.token_version = (user.token_version || 0) + 1;
  await user.save();
  await audit(req, 'CHANGE_PASSWORD', 'auth', `${req.user.name} changed their password`);
  res.json({ success: true, message: 'Password changed successfully.' });
};

/* ── Forgotten password ───────────────────────────────────────────────────── */

const RESET_MINUTES = 15;
const RESET_MAX_TRIES = 5;
const RESET_RESEND_SECONDS = 60;
const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');
const SAME_ANSWER = 'If that email has an account, a reset code is on its way.';

// Always answers the same way, whether or not the account exists, and never
// hands anything back: the code goes to the inbox and nowhere else.
const forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (typeof email !== 'string' || !email.trim()) return res.status(400).json({ success: false, message: 'Email is required.' });
  const normalised = email.toLowerCase().trim();
  const user = await User.findOne({ email: normalised, is_active: true }).select('+reset_sent_at');

  if (user) {
    const recently = user.reset_sent_at && Date.now() - new Date(user.reset_sent_at).getTime() < RESET_RESEND_SECONDS * 1000;
    if (!recently) {
      const code = crypto.randomInt(100000, 1000000).toString();
      await User.updateOne({ _id: user._id }, {
        $set: { reset_code_hash: hashCode(code), reset_expires: new Date(Date.now() + RESET_MINUTES * 60000), reset_attempts: 0, reset_sent_at: new Date() },
      });
      const mail = codeEmail({ heading: 'Reset your password', intro: 'Use this code to choose a new GEMS password:', code, minutes: RESET_MINUTES });
      const sent = await sendPlatformMail({ to: normalised, subject: 'Your GEMS password reset code', ...mail });
      if (!sent.sent) {
        console.error('[RESET] could not email the code to', normalised, sent.reason);
        // Only in development, where there may be no mail account: print it.
        if (process.env.NODE_ENV !== 'production') console.log(`[RESET DEV] ${normalised} -> ${code}`);
      }
    }
  }
  res.json({ success: true, message: SAME_ANSWER });
};

const resetPassword = async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (typeof email !== 'string' || !code || !newPassword) {
    return res.status(400).json({ success: false, message: 'email, code and newPassword are required.' });
  }
  const problem = passwordProblem(newPassword);
  if (problem) return res.status(400).json({ success: false, message: problem });

  const user = await User.findOne({ email: email.toLowerCase().trim(), is_active: true }).select('+reset_code_hash +reset_expires +reset_attempts');
  const bad = () => res.status(400).json({ success: false, message: 'That code is not right or has expired. Request a new one.' });
  if (!user || !user.reset_code_hash || !user.reset_expires) return bad();
  if (new Date(user.reset_expires) < new Date() || (user.reset_attempts || 0) >= RESET_MAX_TRIES) {
    await User.updateOne({ _id: user._id }, { $unset: { reset_code_hash: '', reset_expires: '' } });
    return bad();
  }

  const given = Buffer.from(hashCode(String(code).trim()));
  const stored = Buffer.from(user.reset_code_hash);
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
    await User.updateOne({ _id: user._id }, { $inc: { reset_attempts: 1 } });
    return bad();
  }

  user.password_hash = await bcrypt.hash(newPassword, 10);
  user.token_version = (user.token_version || 0) + 1;
  user.failed_login_attempts = 0;
  user.locked_until = undefined;
  user.reset_code_hash = undefined;
  user.reset_expires = undefined;
  user.reset_attempts = 0;
  await user.save();
  req.user = user; req.tenant_id = user.tenant_id;
  await audit(req, 'RESET_PASSWORD', 'auth', `${user.name} reset their password`);
  res.json({ success: true, message: 'Password reset successfully.' });
};

module.exports = {
  login, verifyTwoFactor, resendTwoFactor, getMe, changePassword, forgotPassword, resetPassword,
  setupTwoFactor, enableTwoFactor, disableTwoFactor, sendTwoFactorCode, twoFactorStatus,
  myActivity, logoutEverywhere,
};
