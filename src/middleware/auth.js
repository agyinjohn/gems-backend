const jwt = require('jsonwebtoken');
const { User } = require('../models');

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
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(403).json({ success: false, message: `Access denied. Required role: ${roles.join(' or ')}` });
  next();
};

const superAdminOnly = authorize('super_admin');

module.exports = { authenticate, authorize, superAdminOnly };
