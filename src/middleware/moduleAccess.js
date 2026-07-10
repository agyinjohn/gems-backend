const { Tenant } = require('../models');

const PLAN_MODULES = {
  starter:    ['pos', 'inventory', 'sales', 'reports'],
  pro:        ['pos', 'inventory', 'sales', 'reports', 'online_storefront', 'procurement', 'hr', 'crm'],
  enterprise: ['pos', 'inventory', 'sales', 'reports', 'online_storefront', 'procurement', 'hr', 'crm', 'advanced_accounting'],
};

// Derive allowed modules for a tenant
function getAllowedModules(plan, removedFeatures = []) {
  const base = PLAN_MODULES[plan] || PLAN_MODULES.starter;
  return base.filter(m => !removedFeatures.includes(m));
}

// Middleware factory — requireModule('hr'), requireModule('crm'), etc.
function requireModule(module) {
  return async (req, res, next) => {
    try {
      // Platform admins bypass module gating
      if (req.user?.role === 'platform_admin') return next();

      const tenant = await Tenant.findById(req.tenant_id).select('plan subscription_status trial_ends_at removed_features');
      if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

      const { plan, subscription_status, trial_ends_at, removed_features = [] } = tenant;

      // Trial — full access until trial ends
      if (subscription_status === 'trial') {
        if (trial_ends_at && new Date(trial_ends_at) > new Date()) return next();
        return res.status(403).json({ success: false, message: 'Your free trial has expired. Please subscribe to continue.' });
      }

      // Expired or suspended — block everything except dashboard/billing
      if (subscription_status === 'expired' || subscription_status === 'suspended') {
        return res.status(403).json({ success: false, message: 'Your subscription is inactive. Please renew to access this feature.' });
      }

      const allowed = getAllowedModules(plan, removed_features);
      if (!allowed.includes(module)) {
        return res.status(403).json({ success: false, message: `Your current plan does not include ${module}. Upgrade to unlock it.` });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireModule, getAllowedModules, PLAN_MODULES };
