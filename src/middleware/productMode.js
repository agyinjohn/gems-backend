const { getProductMode, isRouteAllowed, getModeMeta } = require('../config/productMode');

/**
 * Blocks API routes outside the active product bundle (when PRODUCT_MODE != full).
 * Platform admins bypass the gate.
 */
const productModeGate = (req, res, next) => {
  const mode = getProductMode();
  if (mode === 'full') return next();

  const path = req.path || '';
  if (isRouteAllowed(path, mode)) return next();

  if (req.user?.role === 'platform_admin') return next();

  const meta = getModeMeta(mode);
  return res.status(403).json({
    success: false,
    code: 'PRODUCT_MODE_RESTRICTED',
    message: `This endpoint is not available in ${meta.label} deployment.`,
    product_mode: mode,
  });
};

module.exports = { productModeGate };
