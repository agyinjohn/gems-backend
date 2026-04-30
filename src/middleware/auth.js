const jwt = require('jsonwebtoken');
const { User, Tenant } = require('../models');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id, '-password_hash');
    if (!user || !user.is_active) return res.status(401).json({ success: false, message: 'User not found or deactivated.' });
    if ((decoded.tv ?? 0) !== (user.token_version || 0)) return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });

    req.user = user;

    // Attach tenant if user belongs to one
    if (user.tenant_id) {
      const tenant = await Tenant.findById(user.tenant_id);
      if (!tenant || !tenant.is_active) return res.status(403).json({ success: false, message: 'Your business account is inactive.' });

      // Check subscription (platform_admin and billing routes bypass this)
      if (user.role !== 'platform_admin' && !req.path?.startsWith('/billing') && !req.path?.startsWith('/my-tenant')) {
        const now = new Date();
        if (tenant.subscription_status === 'suspended') return res.status(403).json({ success: false, message: 'Your subscription has been suspended. Please contact support.' });
        if (tenant.subscription_status === 'expired' || tenant.subscription_expires_at < now) {
          // Allow read-only grace period of 7 days
          const gracePeriodEnd = new Date(tenant.subscription_expires_at.getTime() + 7 * 24 * 60 * 60 * 1000);
          if (now > gracePeriodEnd) return res.status(403).json({ success: false, message: 'Your subscription has expired. Please renew to continue.' });
        }
      }

      req.tenant = tenant;
      req.tenant_id = tenant._id;
    }

    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(403).json({ success: false, message: `Access denied. Required role: ${roles.join(' or ')}` });
  next();
};

const platformAdminOnly = authorize('platform_admin');
const businessOwnerOnly = authorize('platform_admin', 'business_owner');
const superAdminOnly    = authorize('platform_admin', 'business_owner'); // backward compat

// Ensure request is scoped to a tenant
const requireTenant = (req, res, next) => {
  if (!req.tenant_id) return res.status(403).json({ success: false, message: 'No business account associated with this user.' });
  next();
};

module.exports = { authenticate, authorize, platformAdminOnly, businessOwnerOnly, superAdminOnly, requireTenant };
