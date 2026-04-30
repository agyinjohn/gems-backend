const { Tenant, BillingTransaction, PlatformSettings, CardAuthorization } = require('../models');
const audit = require('../utils/audit');

const PLAN_PRICES_USD = { starter: 29, pro: 79, enterprise: 199 };

// GET /billing/status
const getStatus = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  const settings = await PlatformSettings.findOne() || { trial_days: 14, grace_days: 7, plans: {} };
  const planPrices = settings.plans || {};
  const planPrice = planPrices[tenant.plan]?.price ?? PLAN_PRICES_USD[tenant.plan] ?? 0;
  const days = tenant.subscription_expires_at
    ? Math.ceil((new Date(tenant.subscription_expires_at).getTime() - Date.now()) / 86400000)
    : null;

  // Calculate total subscription duration from last successful transaction
  const { BillingTransaction } = require('../models');
  const lastTx = await BillingTransaction.findOne({ tenant_id: req.tenant_id, status: 'success' }).sort({ createdAt: -1 });
  const total_days = lastTx?.duration_days || 30;

  res.json({ success: true, data: {
    plan:                   tenant.plan,
    subscription_status:    tenant.subscription_status,
    subscription_expires_at:tenant.subscription_expires_at,
    trial_ends_at:          tenant.trial_ends_at,
    days_remaining:         days,
    total_days:             total_days,
    grace_days:             settings.grace_days,
    max_branches:           tenant.max_branches,
    max_users:              tenant.max_users,
    plan_price:             planPrice,
    card_saved:             tenant.card_saved || false,
    auto_renew:             tenant.auto_renew !== false,
  }});
};

// GET /billing/transactions
const getTransactions = async (req, res) => {
  const data = await BillingTransaction.find({ tenant_id: req.tenant_id }).sort({ createdAt: -1 }).limit(20);
  res.json({ success: true, data });
};

// POST /billing/subscribe — initiate Paystack payment
const subscribe = async (req, res) => {
  const { plan, duration_days = 30 } = req.body;
  if (!plan || !PLAN_PRICES_USD[plan]) return res.status(400).json({ success: false, message: 'Valid plan required: starter, pro, enterprise.' });

  const settings = await PlatformSettings.findOne();
  const planPrices = settings?.plans || PLAN_PRICES_USD;
  const amount = (planPrices[plan]?.price || PLAN_PRICES_USD[plan]) * (duration_days / 30);

  const tenant = await Tenant.findById(req.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  // Create pending transaction
  const tx = await BillingTransaction.create({
    tenant_id:    req.tenant_id,
    plan,
    amount,
    currency:     'USD',
    status:       'pending',
    duration_days,
    initiated_by: req.user._id,
  });

  res.json({ success: true, data: {
    transaction_id:    tx._id,
    amount,
    plan,
    duration_days,
    email:             tenant.email,
    paystack_public_key: process.env.PAYSTACK_PUBLIC_KEY,
    reference:         `BILLING-${tx._id}-${Date.now()}`,
  }});
};

// POST /billing/verify — verify Paystack payment and activate subscription
const verify = async (req, res) => {
  const { reference, transaction_id } = req.body;
  if (!reference || !transaction_id) return res.status(400).json({ success: false, message: 'reference and transaction_id required.' });

  const tx = await BillingTransaction.findOne({ _id: transaction_id, tenant_id: req.tenant_id });
  if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found.' });
  if (tx.status === 'success') return res.status(400).json({ success: false, message: 'Transaction already processed.' });

  // Verify with Paystack
  const https = require('node:https');
  const options = {
    hostname: 'api.paystack.co',
    path:     `/transaction/verify/${reference}`,
    method:   'GET',
    headers:  { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  };

  let body = '';
  const paystackReq = https.request(options, paystackRes => {
    paystackRes.on('data', d => body += d);
    paystackRes.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (data.data?.status === 'success') {
          // Calculate new expiry
          const tenant = await Tenant.findById(req.tenant_id);
          const base = tenant.subscription_expires_at && new Date(tenant.subscription_expires_at) > new Date()
            ? new Date(tenant.subscription_expires_at)
            : new Date();
          const newExpiry = new Date(base.getTime() + tx.duration_days * 86400000);

          // Update tenant
          await Tenant.findByIdAndUpdate(req.tenant_id, {
            plan:                    tx.plan,
            subscription_status:     'active',
            subscription_expires_at: newExpiry,
            max_branches: tx.plan === 'starter' ? 1 : tx.plan === 'pro' ? 5 : 999,
            max_users:    tx.plan === 'starter' ? 5 : tx.plan === 'pro' ? 20 : 999,
          });

          // Update transaction
          tx.status         = 'success';
          tx.payment_ref    = reference;
          tx.payment_method = data.data?.channel || 'paystack';
          tx.expires_at     = newExpiry;
          await tx.save();

          await audit(req, 'BILLING_PAYMENT', 'billing', `${req.user.name} renewed ${tx.plan} plan for ${tx.duration_days} days`, { plan: tx.plan, amount: tx.amount, reference });

          res.json({ success: true, message: 'Payment verified. Subscription activated!', data: { plan: tx.plan, expires_at: newExpiry } });
        } else {
          tx.status = 'failed';
          await tx.save();
          res.status(400).json({ success: false, message: 'Payment verification failed.' });
        }
      } catch { res.status(500).json({ success: false, message: 'Verification error.' }); }
    });
  });
  paystackReq.on('error', () => res.status(500).json({ success: false, message: 'Could not reach Paystack.' }));
  paystackReq.end();
};

// POST /billing/authorize-card — initialize Paystack to save card (GHS 0.50 charge)
const authorizeCard = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  // Use Paystack initialize to collect card
  const https = require('node:https');
  const payload = JSON.stringify({
    email:    tenant.email,
    amount:   50, // GHS 0.50 in pesewas — will be refunded
    currency: 'GHS',
    metadata: {
      tenant_id:   String(req.tenant_id),
      user_id:     String(req.user._id),
      purpose:     'card_authorization',
    },
    callback_url: `${process.env.FRONTEND_URL}/billing?card_saved=true`,
  });

  const options = {
    hostname: 'api.paystack.co',
    path:     '/transaction/initialize',
    method:   'POST',
    headers:  { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
  };

  let body = '';
  const paystackReq = https.request(options, paystackRes => {
    paystackRes.on('data', d => body += d);
    paystackRes.on('end', () => {
      try {
        const data = JSON.parse(body);
        res.json({ success: true, data: { authorization_url: data.data?.authorization_url, reference: data.data?.reference } });
      } catch { res.status(500).json({ success: false, message: 'Failed to initialize card authorization.' }); }
    });
  });
  paystackReq.on('error', () => res.status(500).json({ success: false, message: 'Could not reach Paystack.' }));
  paystackReq.write(payload);
  paystackReq.end();
};

// POST /billing/save-card — verify and save card after authorization
const saveCard = async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ success: false, message: 'reference required.' });

  const https = require('node:https');
  const options = {
    hostname: 'api.paystack.co',
    path:     `/transaction/verify/${reference}`,
    method:   'GET',
    headers:  { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  };

  let body = '';
  const paystackReq = https.request(options, paystackRes => {
    paystackRes.on('data', d => body += d);
    paystackRes.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (data.data?.status === 'success') {
          const auth = data.data.authorization;

          // Save card authorization
          await CardAuthorization.findOneAndUpdate(
            { tenant_id: req.tenant_id },
            {
              tenant_id:          req.tenant_id,
              user_id:            req.user._id,
              authorization_code: auth.authorization_code,
              card_type:          auth.card_type,
              last4:              auth.last4,
              exp_month:          auth.exp_month,
              exp_year:           auth.exp_year,
              bank:               auth.bank,
              email:              data.data.customer?.email,
              is_active:          true,
            },
            { upsert: true, new: true }
          );

          // Mark tenant card as saved
          await Tenant.findByIdAndUpdate(req.tenant_id, { card_saved: true });

          await audit(req, 'CARD_SAVED', 'billing', `${req.user.name} saved a card for auto-renewal`, { last4: auth.last4, card_type: auth.card_type });

          res.json({ success: true, message: 'Card saved successfully.', data: { last4: auth.last4, card_type: auth.card_type, bank: auth.bank } });
        } else {
          res.status(400).json({ success: false, message: 'Card authorization failed.' });
        }
      } catch { res.status(500).json({ success: false, message: 'Verification error.' }); }
    });
  });
  paystackReq.on('error', () => res.status(500).json({ success: false, message: 'Could not reach Paystack.' }));
  paystackReq.end();
};

// GET /billing/card — get saved card info
const getCard = async (req, res) => {
  const card = await CardAuthorization.findOne({ tenant_id: req.tenant_id, is_active: true });
  res.json({ success: true, data: card ? { last4: card.last4, card_type: card.card_type, bank: card.bank, exp_month: card.exp_month, exp_year: card.exp_year } : null });
};

// POST /billing/cancel — cancel auto-renewal
const cancelSubscription = async (req, res) => {
  await Tenant.findByIdAndUpdate(req.tenant_id, { auto_renew: false });
  await CardAuthorization.findOneAndUpdate({ tenant_id: req.tenant_id }, { is_active: false });
  await audit(req, 'CANCEL_SUBSCRIPTION', 'billing', `${req.user.name} cancelled auto-renewal`);
  res.json({ success: true, message: 'Auto-renewal cancelled. Your subscription will remain active until it expires.' });
};

// POST /billing/charge-card — internal: charge saved card (called by cron)
const chargeCard = async (tenant_id, plan, duration_days = 30) => {
  const card = await CardAuthorization.findOne({ tenant_id, is_active: true });
  if (!card) return { success: false, message: 'No saved card.' };

  const settings = await PlatformSettings.findOne();
  const planPrices = settings?.plans || PLAN_PRICES_USD;
  const amount = Math.round((planPrices[plan]?.price || PLAN_PRICES_USD[plan] || 29) * (duration_days / 30) * 100); // in pesewas

  const https = require('node:https');
  const payload = JSON.stringify({ authorization_code: card.authorization_code, email: card.email, amount, currency: 'GHS' });
  const options = {
    hostname: 'api.paystack.co',
    path:     '/transaction/charge_authorization',
    method:   'POST',
    headers:  { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
  };

  return new Promise((resolve) => {
    let body = '';
    const req = https.request(options, res => {
      res.on('data', d => body += d);
      res.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (data.data?.status === 'success') {
            const tenant = await Tenant.findById(tenant_id);
            const base = tenant.subscription_expires_at && new Date(tenant.subscription_expires_at) > new Date()
              ? new Date(tenant.subscription_expires_at) : new Date();
            const newExpiry = new Date(base.getTime() + duration_days * 86400000);
            await Tenant.findByIdAndUpdate(tenant_id, { subscription_status: 'active', subscription_expires_at: newExpiry });
            await BillingTransaction.create({ tenant_id, plan, amount: amount / 100, currency: 'GHS', status: 'success', payment_ref: data.data.reference, payment_method: 'card_auto', duration_days, expires_at: newExpiry });
            resolve({ success: true, reference: data.data.reference });
          } else {
            await BillingTransaction.create({ tenant_id, plan, amount: amount / 100, currency: 'GHS', status: 'failed', duration_days });
            resolve({ success: false, message: data.message });
          }
        } catch(e) { resolve({ success: false, message: e.message }); }
      });
    });
    req.on('error', () => resolve({ success: false, message: 'Network error' }));
    req.write(payload);
    req.end();
  });
};

module.exports = { getStatus, getTransactions, subscribe, verify, authorizeCard, saveCard, getCard, cancelSubscription, chargeCard };
