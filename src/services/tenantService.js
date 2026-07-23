const { Tenant, PlatformSettings } = require('../models');

const DEFAULT_FEATURE_FLAGS = {
  starter:    { pos: true, crm: false, accounting: false, hr: false, procurement: false, reports: true, storefront: true },
  pro:        { pos: true, crm: true,  accounting: true,  hr: true,  procurement: true,  reports: true,  storefront: true },
  enterprise: { pos: true, crm: true,  accounting: true,  hr: true,  procurement: true,  reports: true,  storefront: true },
};

let settingsCache = null;
let settingsCacheAt = 0;
const SETTINGS_TTL_MS = 60_000;

async function getPlatformSettings() {
  if (settingsCache && Date.now() - settingsCacheAt < SETTINGS_TTL_MS) return settingsCache;
  settingsCache = (await PlatformSettings.findOne()) || { feature_flags: DEFAULT_FEATURE_FLAGS };
  settingsCacheAt = Date.now();
  return settingsCache;
}

function invalidatePlatformSettingsCache() {
  settingsCache = null;
  settingsCacheAt = 0;
}

async function getFeatureFlagsForPlan(plan = 'starter') {
  const settings = await getPlatformSettings();
  const flags = settings.feature_flags || DEFAULT_FEATURE_FLAGS;
  return flags[plan] || flags.starter || DEFAULT_FEATURE_FLAGS.starter;
}

async function isFeatureEnabled(plan, feature, tenant = null) {
  if (plan === 'custom') {
    if (!tenant) {
      const { Tenant } = require('../models');
      // fallback: deny if no tenant context
      return false;
    }
    return (tenant.modules || []).includes(feature);
  }
  const planFlags = await getFeatureFlagsForPlan(plan);
  return planFlags[feature] !== false;
}

/**
 * Load and validate tenant context for an authenticated user.
 * Used by auth middleware — central boundary for tenant + subscription checks.
 */
async function resolveTenantForUser(user, requestPath = '') {
  if (!user.tenant_id) return { tenant: null, tenant_id: null };

  const tenant = await Tenant.findById(user.tenant_id);
  if (!tenant || !tenant.is_active) {
    return { error: { status: 403, message: 'Your business account is inactive.' } };
  }

  if (user.role !== 'platform_admin' && !requestPath.startsWith('/billing') && !requestPath.startsWith('/my-tenant')) {
    const now = new Date();
    if (tenant.subscription_status === 'suspended') {
      return { error: { status: 403, message: 'Your subscription has been suspended. Please contact support.' } };
    }
    if (tenant.subscription_status === 'expired' || tenant.subscription_expires_at < now) {
      const gracePeriodEnd = new Date(tenant.subscription_expires_at.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (now > gracePeriodEnd) {
        return { error: { status: 403, message: 'Your subscription has expired. Please renew to continue.' } };
      }
    }
  }

  return { tenant, tenant_id: tenant._id };
}

module.exports = {
  DEFAULT_FEATURE_FLAGS,
  getPlatformSettings,
  invalidatePlatformSettingsCache,
  getFeatureFlagsForPlan,
  isFeatureEnabled,
  resolveTenantForUser,
};
