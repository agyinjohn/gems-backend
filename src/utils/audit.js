const { AuditLog } = require('../models');
const { getRequestContext } = require('./requestContext');

const audit = async (req, action, module, description, metadata = {}, status = 'success') => {
  try {
    await AuditLog.create({
      tenant_id:   req.tenant_id || req.user?.tenant_id || null,
      branch_id:   req.user?.branch_id || null,
      user_id:     req.user?._id || null,
      user_name:   req.user?.name || 'System',
      user_email:  req.user?.email || null,
      user_role:   req.user?.role || null,
      action,
      module,
      description,
      metadata,
      ...getRequestContext(req),
      status,
    });
  } catch (e) {
    console.error('[Audit] Failed to log:', e.message);
  }
};

module.exports = audit;
