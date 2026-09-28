const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Tenant, Branch, User, OtpVerification } = require('../models');
const { seedChartOfAccounts } = require('../services/accountingService');
const { dispatchToProvider, normalisePhone } = require('../services/smsService');
const { PlatformSettings } = require('../models');

const MAX_ATTEMPTS  = 5;   // wrong guesses before OTP is invalidated
const MAX_SENDS     = 3;   // resends allowed per OTP window
const RESEND_WINDOW = 60 * 60 * 1000; // 1 hour

const platformMailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.PLATFORM_GMAIL_USER,
    pass: process.env.PLATFORM_GMAIL_APP_PASSWORD,
  },
});

/** SHA-256 hash of the OTP — never store plain text. */
function hashOtp(otp) {
  return crypto.createHash('sha256').update(otp).digest('hex');
}

async function sendEmailOtpMail(to, otp) {
  if (!process.env.PLATFORM_GMAIL_USER || !process.env.PLATFORM_GMAIL_APP_PASSWORD) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[EMAIL OTP DEV] ${to} -> ${otp}`);
      return { sent: true };
    }
    return { sent: false };
  }
  try {
    await platformMailer.sendMail({
      from: `"GEMS" <${process.env.PLATFORM_GMAIL_USER}>`,
      to,
      subject: 'Your GEMS verification code',
      text: `Your GEMS email verification code is ${otp}.\n\nIt expires in 10 minutes. Do not share it with anyone.`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#0D3B6E">Verify your email</h2>
        <p>Your GEMS verification code is:</p>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#0D3B6E;padding:16px 0">${otp}</div>
        <p style="color:#666">It expires in 10 minutes. Do not share it with anyone.</p>
      </div>`,
    });
    return { sent: true };
  } catch (err) {
    console.error('[EMAIL OTP]', err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Create or refresh an OTP record.
 * Enforces send_count rate limit — max MAX_SENDS per RESEND_WINDOW.
 * Returns { otp, entry } on success or throws with a user-facing message.
 */
async function issueOtp(filter) {
  const existing = await OtpVerification.findOne(filter);

  if (existing) {
    const windowStart = new Date(Date.now() - RESEND_WINDOW);
    const withinWindow = existing.last_sent_at > windowStart;
    if (withinWindow && existing.send_count >= MAX_SENDS) {
      throw Object.assign(
        new Error(`Too many codes sent. Please wait before requesting another.`),
        { status: 429 },
      );
    }
  }

  const otp      = Math.floor(100000 + Math.random() * 900000).toString();
  const otp_hash = hashOtp(otp);
  const expires_at = new Date(Date.now() + 10 * 60 * 1000);

  const windowStart = new Date(Date.now() - RESEND_WINDOW);
  const resetCount  = !existing || existing.last_sent_at <= windowStart;

  await OtpVerification.findOneAndUpdate(
    filter,
    {
      otp_hash,
      verified:     false,
      attempts:     0,
      expires_at,
      last_sent_at: new Date(),
      send_count:   resetCount ? 1 : (existing.send_count || 0) + 1,
    },
    { upsert: true, new: true },
  );

  return otp;
}

// POST /api/tenants/send-otp
const sendOtp = async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: 'phone is required.' });
  const normalised = normalisePhone(phone);
  if (!normalised) return res.status(400).json({ success: false, message: 'Invalid phone number.' });

  let otp;
  try {
    otp = await issueOtp({ phone: normalised });
  } catch (err) {
    return res.status(err.status || 400).json({ success: false, message: err.message });
  }

  const settings = await PlatformSettings.findOne().select('sms_sender_id').lean();
  const senderId  = settings?.sms_sender_id || 'GEMS';

  const result = await dispatchToProvider({
    to: normalised,
    body: `Your GEMS verification code is ${otp}. It expires in 10 minutes.`,
    senderId,
  });

  if (!result.sent) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[OTP DEV] ${normalised} -> ${otp}`);
      return res.json({ success: true, message: 'OTP sent. (DEV: check server console)' });
    }
    return res.status(503).json({ success: false, message: 'SMS service unavailable. Please try again.' });
  }

  res.json({ success: true, message: 'OTP sent.' });
};

// POST /api/tenants/verify-otp
const verifyOtp = async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ success: false, message: 'phone and otp are required.' });
  const normalised = normalisePhone(phone);
  const entry = await OtpVerification.findOne({ phone: normalised });

  if (!entry) return res.status(400).json({ success: false, message: 'No code found for this number. Please request a new one.' });

  if (new Date() > entry.expires_at) {
    await OtpVerification.deleteOne({ phone: normalised });
    return res.status(400).json({ success: false, message: 'Code has expired. Please request a new one.' });
  }

  if (entry.attempts >= MAX_ATTEMPTS) {
    await OtpVerification.deleteOne({ phone: normalised });
    return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
  }

  if (entry.otp_hash !== hashOtp(String(otp).trim())) {
    await OtpVerification.findOneAndUpdate({ phone: normalised }, { $inc: { attempts: 1 } });
    const remaining = MAX_ATTEMPTS - (entry.attempts + 1);
    return res.status(400).json({
      success: false,
      message: remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
        : 'Too many incorrect attempts. Please request a new code.',
    });
  }

  entry.verified = true;
  await entry.save();
  res.json({ success: true, message: 'Phone number verified.' });
};

// POST /api/tenants/send-email-otp
const sendEmailOtp = async (req, res) => {
  const { email } = req.body;
  if (!email || !/\S+@\S+\.\S+/.test(email)) {
    return res.status(400).json({ success: false, message: 'A valid email address is required.' });
  }
  const normalised = email.toLowerCase().trim();

  // Block if this email already has a verified tenant account
  const existing = await Tenant.findOne({ email: normalised });
  if (existing) return res.status(400).json({ success: false, message: 'An account with this email already exists.' });

  let otp;
  try {
    otp = await issueOtp({ email: normalised });
  } catch (err) {
    return res.status(err.status || 400).json({ success: false, message: err.message });
  }

  const result = await sendEmailOtpMail(normalised, otp);
  if (!result.sent) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[EMAIL OTP DEV] ${normalised} -> ${otp}`);
      return res.json({ success: true, message: 'Code sent. (DEV: check server console)' });
    }
    return res.status(503).json({ success: false, message: 'Could not send verification email. Please try again.' });
  }

  res.json({ success: true, message: 'Verification code sent to your email.' });
};

// POST /api/tenants/verify-email-otp
const verifyEmailOtp = async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ success: false, message: 'email and otp are required.' });
  const normalised = email.toLowerCase().trim();
  const entry = await OtpVerification.findOne({ email: normalised });

  if (!entry) return res.status(400).json({ success: false, message: 'No code found for this email. Please request a new one.' });

  if (new Date() > entry.expires_at) {
    await OtpVerification.deleteOne({ email: normalised });
    return res.status(400).json({ success: false, message: 'Code has expired. Please request a new one.' });
  }

  if (entry.attempts >= MAX_ATTEMPTS) {
    await OtpVerification.deleteOne({ email: normalised });
    return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
  }

  if (entry.otp_hash !== hashOtp(String(otp).trim())) {
    await OtpVerification.findOneAndUpdate({ email: normalised }, { $inc: { attempts: 1 } });
    const remaining = MAX_ATTEMPTS - (entry.attempts + 1);
    return res.status(400).json({
      success: false,
      message: remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
        : 'Too many incorrect attempts. Please request a new code.',
    });
  }

  entry.verified = true;
  await entry.save();
  res.json({ success: true, message: 'Email verified.' });
};

// POST /api/tenants/register
const registerTenant = async (req, res) => {
  const { business_name, email, password, phone, address, plan, removed_features } = req.body;
  if (!business_name || !email || !password || !phone || !address) {
    return res.status(400).json({ success: false, message: 'business_name, email, password, phone and address are required.' });
  }

  const validPlans  = ['starter', 'pro', 'enterprise'];
  const chosenPlan  = validPlans.includes(plan) ? plan : 'pro';
  const normalised  = normalisePhone(phone);
  const normEmail   = email.toLowerCase().trim();

  // Verify phone OTP record
  const phoneEntry = await OtpVerification.findOne({ phone: normalised });
  if (!phoneEntry?.verified) {
    return res.status(400).json({ success: false, message: 'Phone number not verified. Please verify your number before registering.' });
  }
  if (new Date() > phoneEntry.expires_at) {
    await OtpVerification.deleteOne({ phone: normalised });
    return res.status(400).json({ success: false, message: 'Phone verification has expired. Please verify again.' });
  }

  // Verify email OTP record
  const emailEntry = await OtpVerification.findOne({ email: normEmail });
  if (!emailEntry?.verified) {
    return res.status(400).json({ success: false, message: 'Email not verified. Please verify your email before registering.' });
  }
  if (new Date() > emailEntry.expires_at) {
    await OtpVerification.deleteOne({ email: normEmail });
    return res.status(400).json({ success: false, message: 'Email verification has expired. Please verify again.' });
  }

  const existing = await Tenant.findOne({ email: normEmail });
  if (existing) return res.status(400).json({ success: false, message: 'A business with this email already exists.' });

  // Consume both OTP records
  await OtpVerification.deleteOne({ phone: normalised });
  await OtpVerification.deleteOne({ email: normEmail });

  let slug = business_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const slugExists = await Tenant.findOne({ slug });
  if (slugExists) slug = `${slug}-${Date.now().toString().slice(-4)}`;

  const tenant = await Tenant.create({
    business_name, slug,
    email: normEmail,
    phone, address,
    plan: chosenPlan,
    removed_features: Array.isArray(removed_features) ? removed_features : [],
    subscription_status: 'trial',
    trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    subscription_expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });

  const branch = await Branch.create({
    tenant_id: tenant._id,
    name: 'Main Branch',
    slug: 'main',
    address,
    email: normEmail,
  });

  const password_hash = await bcrypt.hash(password, 10);
  const owner = await User.create({
    tenant_id: tenant._id,
    branch_id: null,
    name: business_name,
    email: normEmail,
    password_hash,
    role: 'business_owner',
  });

  branch.manager_id = owner._id;
  await branch.save();

  await seedChartOfAccounts(tenant._id);

  res.status(201).json({
    success: true,
    message: 'Business registered successfully. You can now log in.',
    data: {
      tenant: {
        id: tenant._id,
        business_name: tenant.business_name,
        slug: tenant.slug,
        plan: tenant.plan,
        subscription_status: tenant.subscription_status,
        subscription_expires_at: tenant.subscription_expires_at,
      },
    },
  });
};

// GET /api/platform/tenants
const getAllTenants = async (req, res) => {
  const tenants = await Tenant.find().sort({ createdAt: -1 });
  const data = await Promise.all(tenants.map(async t => {
    const userCount   = await User.countDocuments({ tenant_id: t._id });
    const branchCount = await Branch.countDocuments({ tenant_id: t._id });
    return { ...t.toJSON(), user_count: userCount, branch_count: branchCount };
  }));
  res.json({ success: true, data });
};

// GET /api/platform/tenants/:id
const getTenant = async (req, res) => {
  const tenant = await Tenant.findById(req.params.id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  const branches = await Branch.find({ tenant_id: tenant._id });
  const users    = await User.find({ tenant_id: tenant._id }, '-password_hash');
  res.json({ success: true, data: { ...tenant.toJSON(), branches, users } });
};

// PATCH /api/platform/tenants/:id
const updateTenant = async (req, res) => {
  const { plan, subscription_status, subscription_expires_at, max_branches, max_users, is_active } = req.body;
  const update = {};
  if (plan !== undefined)                   update.plan = plan;
  if (subscription_status !== undefined)    update.subscription_status = subscription_status;
  if (subscription_expires_at !== undefined) update.subscription_expires_at = subscription_expires_at;
  if (max_branches !== undefined)           update.max_branches = max_branches;
  if (max_users !== undefined)              update.max_users = max_users;
  if (is_active !== undefined)              update.is_active = is_active;
  const tenant = await Tenant.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  res.json({ success: true, data: tenant });
};

// PATCH /api/platform/tenants/:id/suspend
const suspendTenant = async (req, res) => {
  const tenant = await Tenant.findByIdAndUpdate(
    req.params.id,
    { subscription_status: 'suspended', is_active: false },
    { new: true },
  );
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  res.json({ success: true, message: 'Tenant suspended.', data: tenant });
};

// PATCH /api/platform/tenants/:id/activate
const activateTenant = async (req, res) => {
  const { expires_at, plan } = req.body;
  const update = {
    subscription_status: 'active',
    is_active: true,
    subscription_expires_at: expires_at || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  };
  if (plan !== undefined) {
    if (!['starter', 'pro', 'enterprise'].includes(plan)) {
      return res.status(400).json({ success: false, message: 'Valid plan required: starter, pro, enterprise.' });
    }
    update.plan         = plan;
    update.max_branches = plan === 'starter' ? 1 : plan === 'pro' ? 5 : 999;
    update.max_users    = plan === 'starter' ? 5 : plan === 'pro' ? 20 : 999;
  }
  const tenant = await Tenant.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  res.json({ success: true, message: 'Tenant activated.', data: tenant });
};

// GET /api/my-tenant
const getMyTenant = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  const branches  = await Branch.find({ tenant_id: tenant._id, is_active: true });
  const userCount = await User.countDocuments({ tenant_id: tenant._id, is_active: true });
  res.json({ success: true, data: { ...tenant.toJSON(), branches, user_count: userCount } });
};

module.exports = {
  sendOtp, verifyOtp,
  sendEmailOtp, verifyEmailOtp,
  registerTenant,
  getAllTenants, getTenant, updateTenant, suspendTenant, activateTenant,
  getMyTenant,
};
