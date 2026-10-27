const path = require('path'); const SRC = path.join(__dirname, '../src');
process.env.JWT_SECRET = 'test-secret'; process.env.NODE_ENV = 'test';
const bcrypt = require(require.resolve('bcryptjs'));
const jwt = require(require.resolve('jsonwebtoken'));
const express = require(require.resolve('express'));
const http = require('http');
require(require.resolve('express-async-errors'));

// ── in-memory models ─────────────────────────────────────────────────────────
let seq = 1;
const getv = (d, k) => d[k];
const matches = (d, q) => Object.entries(q).every(([k, v]) => {
  if (k === '$or') return v.some(x => matches(d, x));
  if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) { if ('$ne' in v) return String(d[k]) !== String(v.$ne); }
  return String(getv(d, k)) === String(v);
});
const apply = (d, u) => {
  Object.entries(u.$set || {}).forEach(([k, v]) => { d[k] = v; });
  Object.keys(u.$unset || {}).forEach(k => { delete d[k]; });
  Object.entries(u.$inc || {}).forEach(([k, v]) => { d[k] = (d[k] || 0) + v; });
  Object.entries(u.$pull || {}).forEach(([k, v]) => { d[k] = (d[k] || []).filter(x => x !== v); });
};
class Query { constructor(fn) { this.fn = fn; } populate() { return this; } select() { return this; } lean() { return this; } then(a, b) { return Promise.resolve().then(this.fn).then(a, b); } }
const wrap = (d) => d && Object.assign(d, { toObject() { const { toObject, save, ...rest } = this; return JSON.parse(JSON.stringify(rest)); }, async save() { return this; } });
function coll(name) {
  const rows = [];
  return {
    rows,
    findOne: (q) => new Query(() => wrap(rows.find(r => matches(r, q))) || null),
    findById: (id) => new Query(() => wrap(rows.find(r => String(r._id) === String(id))) || null),
    async countDocuments() { return 0; },
    async create(d) { const doc = { _id: `${name}${seq++}`, ...d }; rows.push(doc); return wrap(doc); },
    async updateOne(q, u) { const d = rows.find(r => matches(r, q)); if (d) apply(d, u); },
    findOneAndUpdate: (q, u, o) => new Query(() => { const d = rows.find(r => matches(r, q)); if (d) apply(d, u); return wrap(d) || null; }),
  };
}
const models = { User: coll('u'), Tenant: coll('t'), Branch: coll('b'), Product: coll('p'), AuditLog: coll('a'), ChatConversation: coll('c'), Employee: coll('e'), PlatformSettings: coll('ps') };
require.cache[path.join(SRC, 'models/index.js')] = { loaded: true, exports: models };
const mail = []; require.cache[path.join(SRC, 'services/platformMailService.js')] = { loaded: true, exports: {
  sendPlatformMail: async (m) => { mail.push(m); return { sent: true }; },
  codeEmail: ({ code }) => ({ text: `code ${code}`, html: `code ${code}` }),
} };
const texts = []; let smsUp = true;
require.cache[path.join(SRC, 'services/smsService.js')] = { loaded: true, exports: {
  normalisePhone: (raw) => { const d = String(raw || '').replace(/[^\d+]/g, ''); if (!d) return null; if (d.startsWith('+')) return d; if (d.startsWith('0')) return `+233${d.slice(1)}`; return `+${d}`; },
  dispatchToProvider: async (m) => { if (!smsUp) return { sent: false, reason: 'down' }; texts.push(m); return { sent: true }; },
} };

const auth = require(path.join(SRC, 'controllers/authController.js'));
const sanitize = require(path.join(SRC, 'middleware/sanitize.js'));
const limits = require(path.join(SRC, 'middleware/rateLimits.js'));
const { authenticate } = require(path.join(SRC, 'middleware/auth.js'));
const totp = require(path.join(SRC, 'utils/totp.js'));
const secretBox = require(path.join(SRC, 'utils/secretBox.js'));

// ── tiny app ─────────────────────────────────────────────────────────────────
const app = express(); app.set('trust proxy', true);
app.use(express.json()); app.use(sanitize);
const r = express.Router();
r.post('/auth/login', limits.login, auth.login);
r.post('/auth/2fa/verify', limits.login, auth.verifyTwoFactor);
r.post('/auth/forgot-password', limits.forgotPassword, auth.forgotPassword);
r.post('/auth/reset-password', limits.resetPassword, auth.resetPassword);
r.post('/auth/2fa/setup', authenticate, auth.setupTwoFactor);
r.post('/auth/2fa/enable', authenticate, auth.enableTwoFactor);
r.post('/auth/2fa/resend', auth.resendTwoFactor);
r.post('/auth/2fa/send-code', authenticate, auth.sendTwoFactorCode);
r.post('/auth/2fa/disable', authenticate, auth.disableTwoFactor);
r.get('/auth/2fa/status', authenticate, auth.twoFactorStatus);
r.post('/auth/logout-all', authenticate, auth.logoutEverywhere);
r.get('/whoami', authenticate, (req, res) => res.json({ ok: true, id: String(req.user._id) }));
r.get('/echo', (req, res) => res.json({ query: req.query }));
r.post('/echo', (req, res) => res.json({ body: req.body }));
app.use('/api', r);
app.use((err, req, res, next) => res.status(err.status || 500).json({ success: false, message: err.message }));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(cond ? 'PASS' : 'FAIL', name, extra); };

(async () => {
  const server = http.createServer(app); await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, p, body, token, ip) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...(ip && { 'x-forwarded-for': ip }) }, body: body && JSON.stringify(body) });
    return { s: res.status, j: await res.json().catch(() => ({})) };
  };
  const mkUser = async (email, pw, extra = {}) => models.User.create({ email, name: email.split('@')[0], role: 'business_owner', tenant_id: 'T1', is_active: true, token_version: 0, password_hash: await bcrypt.hash(pw, 4), failed_login_attempts: 0, ...extra });
  models.Tenant.rows.push({ _id: 'T1', is_active: true, business_name: 'B', slug: 'b', plan: 'pro', subscription_status: 'trial' });

  // ── 1. sanitiser ──────────────────────────────────────────────────────────
  let x = await call('GET', '/echo?status[$ne]=done&ok=1&a.b=2');
  ok('query operators stripped', JSON.stringify(x.j.query) === JSON.stringify({ status: {}, ok: '1' }), JSON.stringify(x.j.query));
  x = await call('POST', '/echo', { email: { $gt: '' }, nested: { $where: 'x', fine: 1 }, list: [{ $ne: 1, keep: 2 }] });
  ok('body operators stripped', JSON.stringify(x.j.body) === JSON.stringify({ email: {}, nested: { fine: 1 }, list: [{ keep: 2 }] }), JSON.stringify(x.j.body));

  // ── 2. login, lockout ─────────────────────────────────────────────────────
  await mkUser('owner@biz.com', 'Str0ng!pass');
  x = await call('POST', '/auth/login', { email: 'owner@biz.com', password: 'Str0ng!pass' }, null, '10.0.0.1');
  ok('good login works', x.s === 200 && x.j.data?.token, '');
  ok('login payload has no secrets', !JSON.stringify(x.j).match(/twofa_secret|reset_code_hash|password_hash/));
  x = await call('POST', '/auth/login', { email: { $gt: '' }, password: 'x' }, null, '10.0.0.2');
  ok('operator injection in login refused', x.s === 400, x.j.message);
  x = await call('POST', '/auth/login', { email: 'nobody@biz.com', password: 'whatever' }, null, '10.0.0.3');
  ok('unknown user gets generic 401', x.s === 401 && /Invalid email or password/.test(x.j.message));
  let last;
  for (let i = 1; i <= 5; i++) last = await call('POST', '/auth/login', { email: 'owner@biz.com', password: 'wrong' + i }, null, '10.0.1.' + i);
  ok('5th wrong password locks the account', last.s === 429 && /locked/i.test(last.j.message), last.j.message);
  x = await call('POST', '/auth/login', { email: 'owner@biz.com', password: 'Str0ng!pass' }, null, '10.0.9.9');
  ok('correct password refused while locked', x.s === 429, x.j.message);
  models.User.rows.find(u => u.email === 'owner@biz.com').locked_until = new Date(Date.now() - 1000);
  x = await call('POST', '/auth/login', { email: 'owner@biz.com', password: 'Str0ng!pass' }, null, '10.0.9.8');
  ok('lock expires and login works again', x.s === 200);
  ok('failed logins are audited', models.AuditLog.rows.filter(a => a.action === 'LOGIN_FAILED').length >= 5);

  // ── 3. rate limit ─────────────────────────────────────────────────────────
  let codes = [];
  for (let i = 0; i < 12; i++) codes.push((await call('POST', '/auth/login', { email: 'ghost@biz.com', password: 'x' }, null, '10.9.9.9')).s);
  ok('11th login try from one address+email is throttled', codes.slice(0, 10).every(c => c === 401) && codes[10] === 429, codes.join(','));
  x = await call('POST', '/auth/login', { email: 'other-ghost@biz.com', password: 'x' }, null, '10.9.9.9');
  ok('a different email from the same address is not blocked', x.s === 401);

  // ── 4. password reset ─────────────────────────────────────────────────────
  await mkUser('reset@biz.com', 'Old#Passw0rd');
  const known = await call('POST', '/auth/forgot-password', { email: 'reset@biz.com' }, null, '10.2.0.1');
  const unknown = await call('POST', '/auth/forgot-password', { email: 'nope@biz.com' }, null, '10.2.0.2');
  ok('forgot-password answers identically for known and unknown emails', JSON.stringify(known.j) === JSON.stringify(unknown.j) && known.s === unknown.s, JSON.stringify(known.j));
  ok('response contains no id or code', !/verification|code|\\d{6}/i.test(JSON.stringify(known.j).replace('reset code is on its way', '')));
  const sent = mail.at(-1); const code = sent.text.match(/(\d{6})/)[1];
  ok('code went to the inbox', sent.to === 'reset@biz.com' && /^\d{6}$/.test(code));
  const stored = models.User.rows.find(u => u.email === 'reset@biz.com');
  ok('code stored hashed, not plain', stored.reset_code_hash && !JSON.stringify(stored).includes(code));
  x = await call('POST', '/auth/reset-password', { email: 'reset@biz.com', code: '000000', newPassword: 'New#Passw0rd1' }, null, '10.2.0.3');
  ok('wrong code refused', x.s === 400);
  x = await call('POST', '/auth/reset-password', { email: 'reset@biz.com', code, newPassword: 'weak' }, null, '10.2.0.3');
  ok('weak new password refused', x.s === 400 && /8 characters/.test(x.j.message), x.j.message);
  const before = stored.token_version;
  x = await call('POST', '/auth/reset-password', { email: 'reset@biz.com', code, newPassword: 'New#Passw0rd1' }, null, '10.2.0.4');
  ok('correct code resets the password', x.s === 200, x.j.message);
  ok('reset invalidates old sessions', stored.token_version === before + 1);
  x = await call('POST', '/auth/reset-password', { email: 'reset@biz.com', code, newPassword: 'Another#Pass1' }, null, '10.2.0.5');
  ok('code cannot be used twice', x.s === 400);
  // brute force: 5 wrong tries kills the code even if the 6th is right
  await call('POST', '/auth/forgot-password', { email: 'reset@biz.com' }, null, '10.2.0.6');
  stored.reset_sent_at = new Date(Date.now() - 120000); await call('POST', '/auth/forgot-password', { email: 'reset@biz.com' }, null, '10.2.0.6');
  const code2 = mail.at(-1).text.match(/(\d{6})/)[1];
  for (let i = 0; i < 5; i++) await call('POST', '/auth/reset-password', { email: 'reset@biz.com', code: '11111' + i, newPassword: 'New#Passw0rd1' }, null, '10.2.1.' + i);
  x = await call('POST', '/auth/reset-password', { email: 'reset@biz.com', code: code2, newPassword: 'New#Passw0rd1' }, null, '10.2.1.9');
  ok('five wrong guesses burn the code', x.s === 400);

  // ── 5. two-factor ─────────────────────────────────────────────────────────
  const owner = await mkUser('twofa@biz.com', 'Str0ng!pass');
  let login = await call('POST', '/auth/login', { email: 'twofa@biz.com', password: 'Str0ng!pass' }, null, '10.3.0.1');
  const session = login.j.data.token;
  let setup = await call('POST', '/auth/2fa/setup', null, session);
  ok('setup returns secret and otpauth url', setup.s === 200 && setup.j.data.secret && /^otpauth:\/\/totp\//.test(setup.j.data.otpauth_url));
  ok('pending secret stored encrypted', owner.twofa_pending_secret && owner.twofa_pending_secret !== setup.j.data.secret && secretBox.decrypt(owner.twofa_pending_secret) === setup.j.data.secret);
  let en = await call('POST', '/auth/2fa/enable', { code: '000000' }, session);
  ok('wrong enable code refused', en.s === 400);
  en = await call('POST', '/auth/2fa/enable', { code: totp.totp(setup.j.data.secret) }, session);
  ok('enable with a valid code', en.s === 200 && en.j.data.recovery_codes.length === 10, '');
  const recovery = en.j.data.recovery_codes;
  ok('recovery codes stored hashed', owner.twofa_recovery.length === 10 && !owner.twofa_recovery.some(h => recovery.includes(h)));

  login = await call('POST', '/auth/login', { email: 'twofa@biz.com', password: 'Str0ng!pass' }, null, '10.3.0.2');
  ok('login now stops at the second factor (no session token)', login.j.two_factor_required === true && !login.j.data?.token && login.j.data?.challenge_token);
  const challenge = login.j.data.challenge_token;
  x = await call('GET', '/whoami', null, challenge);
  ok('challenge token is not a session token', x.s === 401);
  x = await call('POST', '/auth/2fa/verify', { challenge_token: challenge, code: '123456' }, null, '10.3.0.3');
  ok('wrong 2FA code refused', x.s === 401);
  // The code already used to enable cannot be replayed; wait for the next step by faking time forward
  const realNow = Date.now; Date.now = () => realNow() + 31000;
  const goodCode = totp.totp(setup.j.data.secret, Date.now());
  x = await call('POST', '/auth/2fa/verify', { challenge_token: challenge, code: goodCode }, null, '10.3.0.4');
  ok('correct 2FA code signs in', x.s === 200 && x.j.data?.token, x.j.message);
  ok('2FA sign-in payload has no secrets', !JSON.stringify(x.j).match(/twofa_secret|twofa_recovery|twofa_pending/));
  x = await call('POST', '/auth/2fa/verify', { challenge_token: challenge, code: goodCode }, null, '10.3.0.5');
  ok('the same code cannot be used twice', x.s === 401);
  Date.now = realNow;
  x = await call('POST', '/auth/2fa/verify', { challenge_token: challenge, recovery_code: recovery[0] }, null, '10.3.0.6');
  ok('a recovery code signs in', x.s === 200 && x.j.data?.token);
  x = await call('POST', '/auth/2fa/verify', { challenge_token: challenge, recovery_code: recovery[0] }, null, '10.3.0.7');
  ok('a recovery code works only once', x.s === 401);
  x = await call('POST', '/auth/2fa/verify', { challenge_token: jwt.sign({ id: owner._id }, 'test-secret', { expiresIn: '5m' }), code: goodCode }, null, '10.3.0.8');
  ok('challenge must be signed with the challenge key', x.s === 401);
  for (let i = 0; i < 5; i++) last = await call('POST', '/auth/2fa/verify', { challenge_token: challenge, code: '99999' + i }, null, '10.3.1.' + i);
  ok('repeated wrong 2FA codes lock the account', last.s === 429 || owner.locked_until, last.j.message);


  // ── 5b. two-factor by text message ────────────────────────────────────────
  const smsUser = await mkUser('sms@biz.com', 'Str0ng!pass');
  models.Employee.rows.push({ _id: 'E1', tenant_id: 'T1', user_id: smsUser._id, phone: '0244111222' });
  let ss = (await call('POST', '/auth/login', { email: 'sms@biz.com', password: 'Str0ng!pass' }, null, '10.6.0.1')).j.data.token;
  x = await call('GET', '/auth/2fa/status', null, ss);
  ok('status suggests the phone on the staff record', x.j.data.enabled === false && x.j.data.suggested_phone === '0244111222', JSON.stringify(x.j.data));
  x = await call('POST', '/auth/2fa/setup', { method: 'sms', phone: '12' }, ss);
  ok('a bad phone number is refused', x.s === 400);
  x = await call('POST', '/auth/2fa/setup', { method: 'carrier-pigeon' }, ss);
  ok('an unknown method is refused', x.s === 400);
  x = await call('POST', '/auth/2fa/setup', { method: 'sms', phone: '024 411 1222' }, ss);
  ok('sms setup texts a code to the number', x.s === 200 && texts.at(-1)?.to === '+233244111222' && /\d{6}/.test(texts.at(-1).body), JSON.stringify(x.j));
  ok('the number is shown masked', x.j.data.destination && !x.j.data.destination.includes('244111222'), x.j.data.destination);
  let smsCode = texts.at(-1).body.match(/(\d{6})/)[1];
  ok('the texted code is stored hashed', smsUser.twofa_otp_hash && !JSON.stringify(smsUser).includes(smsCode));
  x = await call('POST', '/auth/2fa/setup', { method: 'sms', phone: '0244111222' }, ss);
  ok('asking again within 30 seconds is refused', x.s === 429, x.j.message);
  x = await call('POST', '/auth/2fa/enable', { code: '000000' }, ss);
  ok('wrong texted code refused at enable', x.s === 400);
  x = await call('POST', '/auth/2fa/enable', { code: smsCode }, ss);
  ok('right texted code turns sms two-factor on', x.s === 200 && x.j.data.method === 'sms' && x.j.data.recovery_codes.length === 10, x.j.message);
  ok('the phone is stored for sign-in', smsUser.twofa_method === 'sms' && smsUser.twofa_phone === '+233244111222');
  x = await call('POST', '/auth/2fa/enable', { code: smsCode }, ss);
  ok('the setup code cannot be reused', x.s === 400);

  smsUser.twofa_otp_sent_at = new Date(Date.now() - 60000);
  login = await call('POST', '/auth/login', { email: 'sms@biz.com', password: 'Str0ng!pass' }, null, '10.6.0.2');
  ok('sms login stops at the second factor and texts a code', login.j.two_factor_required && login.j.data.method === 'sms' && !login.j.data.token && /\d{6}/.test(texts.at(-1).body), JSON.stringify(login.j));
  ok('login says where the code went, masked', /•/.test(login.j.data.destination) && !JSON.stringify(login.j).includes('244111222'));
  smsCode = texts.at(-1).body.match(/(\d{6})/)[1];
  const smsChallenge = login.j.data.challenge_token;
  x = await call('POST', '/auth/2fa/resend', { challenge_token: smsChallenge }, null, '10.6.0.3');
  ok('resend straight away is refused', x.s === 429);
  smsUser.twofa_otp_sent_at = new Date(Date.now() - 60000);
  x = await call('POST', '/auth/2fa/resend', { challenge_token: smsChallenge }, null, '10.6.0.3');
  const resent = texts.at(-1).body.match(/(\d{6})/)[1];
  ok('resend after the wait sends a new code', x.s === 200);
  x = await call('POST', '/auth/2fa/verify', { challenge_token: smsChallenge, code: resent === smsCode ? '000001' : smsCode }, null, '10.6.0.4');
  ok('the replaced code no longer works', x.s === 401);
  x = await call('POST', '/auth/2fa/verify', { challenge_token: smsChallenge, code: resent }, null, '10.6.0.5');
  ok('the texted code signs in', x.s === 200 && x.j.data?.token, x.j.message);
  ok('sms sign-in payload has no secrets', !JSON.stringify(x.j).match(/twofa_phone|twofa_otp|twofa_recovery/));
  x = await call('POST', '/auth/2fa/verify', { challenge_token: smsChallenge, code: resent }, null, '10.6.0.6');
  ok('a texted code works once', x.s === 401);
  x = await call('GET', '/auth/2fa/status', null, ss);
  ok('status shows the method and masked phone', x.j.data.enabled && x.j.data.method === 'sms' && /•/.test(x.j.data.destination), JSON.stringify(x.j.data));

  // gateway down at sign-in: still a challenge, flagged, so a recovery code can be used
  smsUp = false; smsUser.twofa_otp_sent_at = new Date(Date.now() - 60000);
  login = await call('POST', '/auth/login', { email: 'sms@biz.com', password: 'Str0ng!pass' }, null, '10.6.0.8');
  ok('a failed text is reported, not hidden', login.j.two_factor_required && login.j.data.send_failed === true, JSON.stringify(login.j.data));
  smsUp = true;

  // five wrong guesses burn a texted code
  smsUser.twofa_otp_sent_at = new Date(Date.now() - 60000); smsUser.failed_login_attempts = 0;
  login = await call('POST', '/auth/login', { email: 'sms@biz.com', password: 'Str0ng!pass' }, null, '10.6.1.0');
  const burnt = texts.at(-1).body.match(/(\d{6})/)[1];
  for (let i = 0; i < 5; i++) { smsUser.failed_login_attempts = 0; await call('POST', '/auth/2fa/verify', { challenge_token: login.j.data.challenge_token, code: '12345' + i }, null, '10.6.1.' + (i + 1)); }
  smsUser.locked_until = undefined;
  x = await call('POST', '/auth/2fa/verify', { challenge_token: login.j.data.challenge_token, code: burnt }, null, '10.6.1.9');
  ok('five wrong guesses burn the texted code', x.s === 401, x.j.message);

  // turning it off needs the password and a fresh code
  smsUser.twofa_otp_sent_at = new Date(Date.now() - 60000);
  x = await call('POST', '/auth/2fa/send-code', null, ss);
  const offCode = texts.at(-1).body.match(/(\d{6})/)[1];
  ok('send-code texts a code to the signed-in user', x.s === 200);
  x = await call('POST', '/auth/2fa/disable', { password: 'wrong', code: offCode }, ss);
  ok('disable needs the password', x.s === 400);
  x = await call('POST', '/auth/2fa/disable', { password: 'Str0ng!pass', code: offCode }, ss);
  ok('disable with password + texted code', x.s === 200 && smsUser.twofa_enabled === false && !smsUser.twofa_phone, x.j.message);

  // ── 5c. two-factor by email ───────────────────────────────────────────────
  const mailUser = await mkUser('mailer@biz.com', 'Str0ng!pass');
  const ms = (await call('POST', '/auth/login', { email: 'mailer@biz.com', password: 'Str0ng!pass' }, null, '10.7.0.1')).j.data.token;
  x = await call('POST', '/auth/2fa/setup', { method: 'email' }, ms);
  ok('email setup mails a code to the account email', x.s === 200 && mail.at(-1).to === 'mailer@biz.com' && /•/.test(x.j.data.destination), JSON.stringify(x.j));
  x = await call('POST', '/auth/2fa/enable', { code: mail.at(-1).text.match(/(\d{6})/)[1] }, ms);
  ok('email two-factor turns on', x.s === 200 && mailUser.twofa_method === 'email');
  mailUser.twofa_otp_sent_at = new Date(Date.now() - 60000);
  login = await call('POST', '/auth/login', { email: 'mailer@biz.com', password: 'Str0ng!pass' }, null, '10.7.0.2');
  ok('email login mails a code', login.j.two_factor_required && login.j.data.method === 'email' && mail.at(-1).to === 'mailer@biz.com');
  x = await call('POST', '/auth/2fa/verify', { challenge_token: login.j.data.challenge_token, code: mail.at(-1).text.match(/(\d{6})/)[1] }, null, '10.7.0.3');
  ok('the emailed code signs in', x.s === 200 && x.j.data?.token, x.j.message);
  x = await call('POST', '/auth/2fa/setup', { method: 'totp' }, ms);
  ok('switching method needs two-factor off first', x.s === 400);

  // ── 6. sign out everywhere ────────────────────────────────────────────────
  const u3 = await mkUser('multi@biz.com', 'Str0ng!pass');
  const t1 = (await call('POST', '/auth/login', { email: 'multi@biz.com', password: 'Str0ng!pass' }, null, '10.4.0.1')).j.data.token;
  x = await call('GET', '/whoami', null, t1); ok('session works', x.s === 200);
  await call('POST', '/auth/logout-all', null, t1);
  x = await call('GET', '/whoami', null, t1); ok('sign-out-everywhere revokes the token', x.s === 401);

  // ── 7. staff session token default lifetime ───────────────────────────────
  const tk = (await call('POST', '/auth/login', { email: 'owner@biz.com', password: 'Str0ng!pass' }, null, '10.5.0.1')).j.data.token;
  const dec = jwt.decode(tk); ok('session lasts one day by default', dec.exp - dec.iat === 86400, String(dec.exp - dec.iat));

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
