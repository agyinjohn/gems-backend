const path = require('path');
const SRC = path.join(__dirname, '../src');
// ── tiny in-memory "collections" ─────────────────────────────────────────
let idc = 1;
const match = (doc, q) => Object.entries(q).every(([k, v]) => String(doc[k]) === String(v));
function coll(name, { failCreate } = {}) {
  const rows = [];
  const wrap = (d) => d && Object.assign(d, { save: async () => d });
  return {
    rows,
    failCreate,
    async exists(q) { return rows.some(r => match(r, q)) ? { _id: 1 } : null; },
    async findOne(q) { return wrap(rows.find(r => match(r, q))) || null; },
    async create(d) {
      if (this.failCreate && this.failCreate(d)) { const e = new Error('E11000 duplicate'); e.code = 11000; throw e; }
      const doc = { _id: `${name}${idc++}`, ...d }; rows.push(doc); return wrap(doc);
    },
    async deleteOne(q) { const i = rows.findIndex(r => match(r, q)); if (i >= 0) rows.splice(i, 1); },
    async deleteMany(q) { for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], q)) rows.splice(i, 1); },
    async findOneAndUpdate(q, u, o) { let d = rows.find(r => match(r, q)); if (!d && o?.upsert) { d = { _id: `${name}${idc++}`, ...q }; rows.push(d); } Object.assign(d, u.$inc ? {} : u); return d; },
  };
}
const models = {
  Tenant: coll('t'), Branch: coll('b'), User: coll('u'), OtpVerification: coll('o'), Account: coll('a'),
  PlatformSettings: { findOne: () => ({ select: () => ({ lean: async () => ({ trial_days: 14, sms_sender_id: 'GEMS' }) }) }) },
};
require.cache[path.join(SRC, 'models/index.js')] = { id: 'm', filename: 'm', loaded: true, exports: models };
let seedFails = false;
require.cache[path.join(SRC, 'services/accountingService.js')] = { loaded: true, exports: { seedChartOfAccounts: async (tid) => { if (seedFails) throw new Error('seed boom'); await models.Account.create({ tenant_id: tid }); } } };
require.cache[path.join(SRC, 'services/smsService.js')] = { loaded: true, exports: { normalisePhone: (p) => '+233' + String(p).replace(/\D/g, '').replace(/^(233|0)/, ''), dispatchToProvider: async () => ({ sent: false }) } };
const ctl = require(path.join(SRC, 'controllers/tenantController.js'));

const call = async (fn, body) => { let status = 200, json; const res = { status(s) { status = s; return this; }, json(j) { json = j; return this; } }; await fn({ body }, res); return { status, json }; };
const verify = async (phone, email) => {
  models.OtpVerification.rows.push({ phone: '+233' + phone, verified: true, expires_at: new Date(Date.now() + 3600e3) });
  models.OtpVerification.rows.push({ email, verified: true, expires_at: new Date(Date.now() + 3600e3) });
};
const ok = (name, cond, extra = '') => console.log(cond ? 'PASS' : 'FAIL', name, extra);
const base = (o = {}) => ({ business_name: 'Kente & Co.', owner_name: 'Nana Adjei', email: 'nana@kente.com', password: 'Strong#123', phone: '0244123456', address: 'Accra', plan: 'pro', ...o });

(async () => {
  // 1. weak password refused
  let r = await call(ctl.registerTenant, base({ password: 'weak' }));
  ok('weak password refused', r.status === 400, r.json.message);

  // 2. happy path: plan limits, owner name, trial, OTPs consumed only after success
  await verify('244123456', 'nana@kente.com');
  r = await call(ctl.registerTenant, base());
  const t = models.Tenant.rows[0];
  ok('registers', r.status === 201, r.json.message);
  ok('pro limits applied', t.max_users === 20 && t.max_branches === 5, `${t.max_users}/${t.max_branches}`);
  ok('owner named as a person', models.User.rows[0].name === 'Nana Adjei');
  ok('phone stored normalised', t.phone === '+233244123456', t.phone);
  ok('OTPs consumed', models.OtpVerification.rows.length === 0);

  // 3. email already used by a staff login elsewhere → refused before anything is created
  models.User.rows.push({ _id: 'staff1', email: 'staff@shop.com' });
  await verify('200000001', 'staff@shop.com');
  const before = models.Tenant.rows.length;
  r = await call(ctl.registerTenant, base({ email: 'staff@shop.com', phone: '0200000001', business_name: 'Shop Two' }));
  ok('email used by a login refused', r.status === 400 && models.Tenant.rows.length === before, r.json.message);

  // 4. failure part-way → everything rolled back, OTPs kept so they can retry
  models.OtpVerification.rows.length = 0;
  await verify('200000002', 'new@biz.com');
  seedFails = true;
  r = await call(ctl.registerTenant, base({ email: 'new@biz.com', phone: '0200000002', business_name: 'New Biz' }));
  ok('failed sign-up rolled back', r.status === 500 && !models.Tenant.rows.some(x => x.email === 'new@biz.com') && !models.User.rows.some(x => x.email === 'new@biz.com') && models.Branch.rows.length === 1, r.json.message);
  ok('codes kept for retry', models.OtpVerification.rows.length === 2);
  seedFails = false;
  r = await call(ctl.registerTenant, base({ email: 'new@biz.com', phone: '0200000002', business_name: 'New Biz' }));
  ok('retry succeeds', r.status === 201, r.json.message);

  // 5. slug for a name with no latin letters, and duplicate slugs
  models.OtpVerification.rows.length = 0;
  await verify('200000003', 'x@y.com');
  r = await call(ctl.registerTenant, base({ email: 'x@y.com', phone: '0200000003', business_name: '★★★' }));
  ok('empty slug falls back', models.Tenant.rows.at(-1).slug === 'business', models.Tenant.rows.at(-1).slug);
  await verify('200000004', 'k2@y.com');
  r = await call(ctl.registerTenant, base({ email: 'k2@y.com', phone: '0200000004' }));
  ok('duplicate slug made unique', models.Tenant.rows.at(-1).slug.startsWith('kente-co-'), models.Tenant.rows.at(-1).slug);

  // 6. verifying a code extends the window to finish signing up
  models.OtpVerification.rows.length = 0;
  const crypto = require('crypto');
  models.OtpVerification.rows.push({ phone: '+233200000005', otp_hash: crypto.createHash('sha256').update('123456').digest('hex'), attempts: 0, expires_at: new Date(Date.now() + 60e3), verified: false });
  r = await call(ctl.verifyOtp, { phone: '0200000005', otp: '123456' });
  const e = models.OtpVerification.rows[0];
  ok('verify extends window to ~60 min', r.status === 200 && e.expires_at - Date.now() > 50 * 60e3);

  // 7. email OTP refused for an address that is already a login
  r = await call(ctl.sendEmailOtp, { email: 'staff@shop.com' });
  ok('send-email-otp refuses existing login', r.status === 400, r.json.message);
})();
