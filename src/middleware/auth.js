const jwt = require('jsonwebtoken');
const { User, Tenant, Role } = require('../models');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id, '-password_hash').populate('custom_role_id', 'name permissions is_active');
    if (!user || !user.is_active) return res.status(401).json({ success: false, message: 'User not found or deactivated.' });
    if ((decoded.tv ?? 0) !== (user.token_version || 0)) return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });

    req.user = user;
    // Expose permissions array for custom roles
    req.permissions = user.custom_role_id?.permissions || [];

    // Attach tenant if user belongs to one
    if (user.tenant_id) {
      const tenant = await Tenant.findById(user.tenant_id);
      if (!tenant || !tenant.is_active) return res.status(403).json({ success: false, message: 'Your business account is inactive.' });

      // Check subscription (platform_admin and billing routes bypass this)
      if (user.role !== 'platform_admin' && !req.path?.startsWith('/billing') && !req.path?.startsWith('/my-tenant')) {
        const now = new Date();
        if (tenant.subscription_status === 'suspended') return res.status(403).json({ success: false, message: 'Your subscription has been suspended. Please contact support.' });
        if (tenant.subscription_status === 'expired' || tenant.subscription_expires_at < now) {
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

// authorize by role string OR by permission key on a custom role
const authorize = (...roles) => (req, res, next) => {
  // business_owner always passes
  if (req.user.role === 'business_owner' || req.user.role === 'platform_admin') return next();
  // standard role match
  if (roles.includes(req.user.role)) return next();
  // custom role — check if the role has any of the required permission keys
  if (req.user.role === 'custom' && req.user.custom_role_id?.is_active) {
    const perms = req.user.custom_role_id.permissions || [];
    if (roles.some(r => perms.includes(r))) return next();
  }
  return res.status(403).json({ success: false, message: 'Access denied.' });
};

// permission-based check (used for fine-grained routes)
const requirePermission = (...perms) => (req, res, next) => {
  if (req.user.role === 'business_owner' || req.user.role === 'platform_admin') return next();
  const userPerms = req.permissions || [];
  if (perms.some(p => userPerms.includes(p))) return next();
  return res.status(403).json({ success: false, message: 'Access denied. Missing permission.' });
};

const platformAdminOnly = authorize('platform_admin');
const businessOwnerOnly = authorize('platform_admin', 'business_owner');
const superAdminOnly    = authorize('platform_admin', 'business_owner');

const requireTenant = (req, res, next) => {
  if (!req.tenant_id) return res.status(403).json({ success: false, message: 'No business account associated with this user.' });
  next();
};

module.exports = { authenticate, authorize, requirePermission, platformAdminOnly, businessOwnerOnly, superAdminOnly, requireTenant };
