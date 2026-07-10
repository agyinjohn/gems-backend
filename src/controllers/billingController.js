const { Tenant, BillingTransaction, PlatformSettings, CardAuthorization } = require('../models');
const audit = require('../utils/audit');
const { verifyPaystackTransaction } = require('../services/paymentService');

const PLAN_PRICES = { starter: 350, pro: 1000, enterprise: 2500 };

const REMOVABLE_FEATURES = {
  online_storefront:   { deduction: { pro: 150, enterprise: 150 } },
  procurement:         { deduction: { pro: 100, enterprise: 100 } },
  hr:                  { deduction: { pro: 150, enterprise: 150 } },
  crm:                 { deduction: { pro: 100, enterprise: 100 } },
  advanced_accounting: { deduction: { enterprise: 500 } },
  priority_support:    { deduction: { pro: 80,  enterprise: 80  } },
};

// GET /billing/module-prices  (public)
const getModulePrices = async (req, res) => {
  res.json({ success: true, data: { removable_features: REMOVABLE_FEATURES } });
};

// GET /billing/status
const getStatus = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  const settings = await PlatformSettings.findOne() || {};
  const planPrices = settings.plans || PLAN_PRICES;
  const planPrice = planPrices[tenant.plan]?.price ?? PLAN_PRICES[tenant.plan] ?? 0;
  const days = tenant.subscription_expires_at
    ? Math.ceil((new Date(tenant.subscription_expires_at).getTime() - Date.now()) / 86400000)
    : null;

  const lastTx = await BillingTransaction.findOne({ tenant_id: req.tenant_id, status: 'success' }).sort({ createdAt: -1 });

  res.json({ success: true, data: {
    plan:                    tenant.plan,
    subscription_type:       tenant.subscription_type || 'plan',
    modules:                 tenant.modules || [],
    addons:                  tenant.addons  || [],
    subscription_status:     tenant.subscription_status,
    subscription_expires_at: tenant.subscription_expires_at,
    trial_ends_at:           tenant.trial_ends_at,
    days_remaining:          days,
    total_days:              lastTx?.duration_days || 30,
    grace_days:              settings.grace_days || 7,
    max_branches:            tenant.max_branches,
    max_users:               tenant.max_users,
    plan_price:              planPrice,
    card_saved:              tenant.card_saved || false,
    auto_renew:              tenant.auto_renew !== false,
  }});
};

// GET /billing/transactions
const getTransactions = async (req, res) => {
  const data = await BillingTransaction.find({ tenant_id: req.tenant_id }).sort({ createdAt: -1 }).limit(20);
  res.json({ success: true, data });
};

// POST /billing/subscribe
const subscribe = async (req, res) => {
  const { plan, duration_days = 30, removed_features = [] } = req.body;

  const tenant = await Tenant.findById(req.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  if (!plan || !['starter','pro','enterprise'].includes(plan)) {
    return res.status(400).json({ success: false, message: 'Valid plan required: starter, pro, enterprise.' });
  }

  const settings = await PlatformSettings.findOne();
  const planPrices = settings?.plans || PLAN_PRICES;
  const base = planPrices[plan]?.price ?? PLAN_PRICES[plan] ?? 0;
  const deduction = removed_features.reduce((s, f) => s + (REMOVABLE_FEATURES[f]?.deduction[plan] || 0), 0);
  const amount = (base - deduction) * (duration_days / 30);

  const tx = await BillingTransaction.create({
    tenant_id: req.tenant_id,
    plan,
    subscription_type: 'plan',
    removed_features,
    amount,
    currency: 'GHS',
    status: 'pending',
    duration_days,
    initiated_by: req.user._id,
  });

  res.json({ success: true, data: {
    transaction_id:      tx._id,
    amount,
    plan,
    removed_features,
    duration_days,
    email:               tenant.email,
    paystack_public_key: process.env.PAYSTACK_PUBLIC_KEY,
    reference:           `BILLING-${tx._id}-${Date.now()}`,
  }});
};

// POST /billing/verify
const verify = async (req, res) => {
  const { reference, transaction_id } = req.body;
  if (!reference || !transaction_id) return res.status(400).json({ success: false, message: 'reference and transaction_id required.' });

  const tx = await BillingTransaction.findOne({ _id: transaction_id, tenant_id: req.tenant_id });
  if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found.' });
  if (tx.status === 'success') return res.status(400).json({ success: false, message: 'Transaction already processed.' });

  try {
    const txData = await verifyPaystackTransaction(reference);

    const tenant = await Tenant.findById(req.tenant_id);
    const base = tenant.subscription_expires_at && new Date(tenant.subscription_expires_at) > new Date()
      ? new Date(tenant.subscription_expires_at) : new Date();
    const newExpiry = new Date(base.getTime() + tx.duration_days * 86400000);

    // Determine branch/user limits
    let max_branches = tenant.max_branches;
    let max_users    = tenant.max_users;
    if (tx.subscription_type === 'plan') {
      max_branches = tx.plan === 'starter' ? 1 : tx.plan === 'pro' ? 5 : 999;
      max_users    = tx.plan === 'starter' ? 5 : tx.plan === 'pro' ? 20 : 999;
    }
    const extraBranches = (tx.addons || []).filter(a => a === 'extra_branch').length;
    const extraUsers    = (tx.addons || []).filter(a => a === 'extra_users').length;
    max_branches = Math.min(999, max_branches + extraBranches);
    max_users    = Math.min(999, max_users + extraUsers * 10);

    await Tenant.findByIdAndUpdate(req.tenant_id, {
      plan:                    tx.plan,
      subscription_type:       tx.subscription_type,
      removed_features:        tx.removed_features || [],
      subscription_status:     'active',
      subscription_expires_at: newExpiry,
      max_branches,
      max_users,
    });

    tx.status         = 'success';
    tx.payment_ref    = reference;
    tx.payment_method = txData?.channel || 'paystack';
    tx.expires_at     = newExpiry;
    await tx.save();

    await audit(req, 'BILLING_PAYMENT', 'billing',
      `${req.user.name} subscribed to ${tx.plan} plan for ${tx.duration_days} days`,
      { plan: tx.plan, amount: tx.amount, reference });

    res.json({ success: true, message: 'Payment verified. Subscription activated!', data: { plan: tx.plan, expires_at: newExpiry } });
  } catch (err) {
    tx.status = 'failed';
    await tx.save();
    res.status(400).json({ success: false, message: err.message || 'Payment verification failed.' });
  }
};

// POST /billing/authorize-card
const authorizeCard = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  const https = require('node:https');
  const payload = JSON.stringify({
    email: tenant.email, amount: 50, currency: 'GHS',
    channels: ['card'],
    metadata: { tenant_id: String(req.tenant_id), user_id: String(req.user._id), purpose: 'card_authorization' },
    callback_url: `${process.env.FRONTEND_URL}/billing?card_saved=true`,
  });
  const options = {
    hostname: 'api.paystack.co', path: '/transaction/initialize', method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
  };
  let body = '';
  const paystackReq = https.request(options, r => {
    r.on('data', d => body += d);
    r.on('end', () => {
      try {
        const data = JSON.parse(body);
        res.json({ success: true, data: {
          authorization_url: data.data?.authorization_url,
          reference: data.data?.reference,
          paystack_public_key: process.env.PAYSTACK_PUBLIC_KEY,
        } });
      } catch { res.status(500).json({ success: false, message: 'Failed to initialize card authorization.' }); }
    });
  });
  paystackReq.on('error', () => res.status(500).json({ success: false, message: 'Could not reach Paystack.' }));
  paystackReq.write(payload);
  paystackReq.end();
};

// POST /billing/save-card
const saveCard = async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ success: false, message: 'reference required.' });
  try {
    const txData = await verifyPaystackTransaction(reference);
    const auth = txData.authorization;
    await CardAuthorization.findOneAndUpdate(
      { tenant_id: req.tenant_id },
      { tenant_id: req.tenant_id, user_id: req.user._id, authorization_code: auth.authorization_code,
        card_type: auth.card_type, last4: auth.last4, exp_month: auth.exp_month, exp_year: auth.exp_year,
        bank: auth.bank, email: txData.customer?.email, is_active: true },
      { upsert: true, new: true }
    );
    await Tenant.findByIdAndUpdate(req.tenant_id, { card_saved: true });
    await audit(req, 'CARD_SAVED', 'billing', `${req.user.name} saved a card`, { last4: auth.last4 });
    res.json({ success: true, message: 'Card saved.', data: { last4: auth.last4, card_type: auth.card_type, bank: auth.bank } });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Card authorization failed.' });
  }
};

// GET /billing/card
const getCard = async (req, res) => {
  const card = await CardAuthorization.findOne({ tenant_id: req.tenant_id, is_active: true });
  res.json({ success: true, data: card
    ? { last4: card.last4, card_type: card.card_type, bank: card.bank, exp_month: card.exp_month, exp_year: card.exp_year }
    : null });
};

// POST /billing/cancel
const cancelSubscription = async (req, res) => {
  await Tenant.findByIdAndUpdate(req.tenant_id, { auto_renew: false });
  await CardAuthorization.findOneAndUpdate({ tenant_id: req.tenant_id }, { is_active: false });
  await audit(req, 'CANCEL_SUBSCRIPTION', 'billing', `${req.user.name} cancelled auto-renewal`);
  res.json({ success: true, message: 'Auto-renewal cancelled. Your subscription will remain active until it expires.' });
};

// Internal: charge saved card (called by cron)
const chargeCard = async (tenant_id, plan, duration_days = 30) => {
  const card = await CardAuthorization.findOne({ tenant_id, is_active: true });
  if (!card) return { success: false, message: 'No saved card.' };

  const settings = await PlatformSettings.findOne();
  const planPrices = settings?.plans || PLAN_PRICES;
  const amount = Math.round((planPrices[plan]?.price ?? PLAN_PRICES[plan] ?? 350) * (duration_days / 30) * 100);

  const https = require('node:https');
  const payload = JSON.stringify({ authorization_code: card.authorization_code, email: card.email, amount, currency: 'GHS' });
  const options = {
    hostname: 'api.paystack.co', path: '/transaction/charge_authorization', method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
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
        } catch (e) { resolve({ success: false, message: e.message }); }
      });
    });
    req.on('error', () => resolve({ success: false, message: 'Network error' }));
    req.write(payload);
    req.end();
  });
};

module.exports = { getModulePrices, getStatus, getTransactions, subscribe, verify, authorizeCard, saveCard, getCard, cancelSubscription, chargeCard };
