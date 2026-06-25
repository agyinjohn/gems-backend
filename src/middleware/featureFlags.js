const { isFeatureEnabled } = require('../services/tenantService');

/**
 * Gate routes by subscription plan feature flags (PlatformSettings.feature_flags).
 * platform_admin always passes.
 */
const requireFeature = (feature) => async (req, res, next) => {
  if (req.user?.role === 'platform_admin') return next();
  if (!req.tenant) return next();

  const enabled = await isFeatureEnabled(req.tenant.plan || 'starter', feature);
  if (!enabled) {
    return res.status(403).json({
      success: false,
      code: 'FEATURE_NOT_AVAILABLE',
      feature,
      message: `Your ${req.tenant.plan || 'starter'} plan does not include ${feature}. Please upgrade to access this feature.`,
    });
  }
  next();
};

module.exports = { requireFeature };
