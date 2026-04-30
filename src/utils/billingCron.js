const { Tenant, CardAuthorization } = require('../models');
const { chargeCard } = require('../controllers/billingController');

const MS_DAY = 24 * 60 * 60 * 1000;

const runBillingCron = async () => {
  console.log('[Cron] Running billing check...');
  const now = new Date();
  const tomorrow = new Date(now.getTime() + MS_DAY);

  // ── 1. WARN tenants whose trial ends within 24 hours (and haven't been warned yet)
  const tenantsToWarn = await Tenant.find({
    is_active:           true,
    trial_warning_sent:  false,
    subscription_status: 'trial',
    trial_ends_at:       { $lte: tomorrow, $gt: now },
  });

  for (const tenant of tenantsToWarn) {
    console.log(`[Cron] ⚠️  Warning tenant: ${tenant.business_name} — trial ends ${tenant.trial_ends_at}`);
    // TODO: send email via your email provider here
    // e.g. sendEmail(tenant.email, 'Your free trial ends tomorrow', ...)
    await Tenant.findByIdAndUpdate(tenant._id, { trial_warning_sent: true });
  }

  // ── 2. CHARGE tenants whose trial/subscription has expired and card is saved
  const tenantsToCharge = await Tenant.find({
    auto_renew: true,
    card_saved:  true,
    is_active:   true,
    $or: [
      { subscription_status: 'trial',  trial_ends_at:           { $lte: now } },
      { subscription_status: 'active', subscription_expires_at: { $lte: now } },
    ],
  });

  console.log(`[Cron] Found ${tenantsToCharge.length} tenant(s) to charge.`);

  for (const tenant of tenantsToCharge) {
    console.log(`[Cron] Charging tenant: ${tenant.business_name} (${tenant.plan})`);
    const result = await chargeCard(tenant._id, tenant.plan, 30);
    if (result.success) {
      console.log(`[Cron] ✅ Charged ${tenant.business_name} — ref: ${result.reference}`);
      // Reset warning flag for next cycle
      await Tenant.findByIdAndUpdate(tenant._id, { trial_warning_sent: false });
    } else {
      console.log(`[Cron] ❌ Failed to charge ${tenant.business_name} — ${result.message}`);
      await Tenant.findByIdAndUpdate(tenant._id, { subscription_status: 'expired' });
    }
  }

  // ── 3. EXPIRE tenants with no card whose trial ended (no auto-renew or no card)
  await Tenant.updateMany(
    {
      is_active:           true,
      subscription_status: 'trial',
      trial_ends_at:       { $lte: now },
      $or: [{ auto_renew: false }, { card_saved: false }],
    },
    { subscription_status: 'expired' }
  );

  console.log('[Cron] Billing check complete.');
};

// Run every 24 hours
const startBillingCron = () => {
  runBillingCron().catch(console.error);
  setInterval(() => runBillingCron().catch(console.error), MS_DAY);
};

module.exports = { startBillingCron, runBillingCron };
