const { AuditLog } = require('../models');

const routeMap = [
  // AUTH
  { method: 'POST',   pattern: /\/auth\/login/,                    action: 'LOGIN',                 module: 'auth' },
  { method: 'POST',   pattern: /\/auth\/change-password/,          action: 'CHANGE_PASSWORD',        module: 'auth' },
  { method: 'POST',   pattern: /\/auth\/forgot-password/,          action: 'FORGOT_PASSWORD',        module: 'auth' },
  { method: 'POST',   pattern: /\/auth\/reset-password/,           action: 'RESET_PASSWORD',         module: 'auth' },
  // USERS
  { method: 'GET',    pattern: /\/users$/,                         action: 'VIEW_USERS',             module: 'users' },
  { method: 'POST',   pattern: /\/users$/,                         action: 'CREATE_USER',            module: 'users' },
  { method: 'PUT',    pattern: /\/users\//,                        action: 'UPDATE_USER',            module: 'users' },
  { method: 'DELETE', pattern: /\/users\//,                        action: 'DEACTIVATE_USER',        module: 'users' },
  // BRANCHES
  { method: 'GET',    pattern: /\/branches$/,                      action: 'VIEW_BRANCHES',          module: 'branches' },
  { method: 'POST',   pattern: /\/branches$/,                      action: 'CREATE_BRANCH',          module: 'branches' },
  { method: 'PUT',    pattern: /\/branches\//,                     action: 'UPDATE_BRANCH',          module: 'branches' },
  { method: 'DELETE', pattern: /\/branches\//,                     action: 'DELETE_BRANCH',          module: 'branches' },
  // INVENTORY
  { method: 'GET',    pattern: /\/products$/,                      action: 'VIEW_PRODUCTS',          module: 'inventory' },
  { method: 'GET',    pattern: /\/products\//,                     action: 'VIEW_PRODUCT',           module: 'inventory' },
  { method: 'POST',   pattern: /\/products$/,                      action: 'CREATE_PRODUCT',         module: 'inventory' },
  { method: 'PUT',    pattern: /\/products\//,                     action: 'UPDATE_PRODUCT',         module: 'inventory' },
  { method: 'DELETE', pattern: /\/products\//,                     action: 'DELETE_PRODUCT',         module: 'inventory' },
  { method: 'POST',   pattern: /\/adjust-stock/,                   action: 'ADJUST_STOCK',           module: 'inventory' },
  { method: 'POST',   pattern: /\/categories$/,                    action: 'CREATE_CATEGORY',        module: 'inventory' },
  // ORDERS
  { method: 'GET',    pattern: /\/orders$/,                        action: 'VIEW_ORDERS',            module: 'orders' },
  { method: 'GET',    pattern: /\/orders\//,                       action: 'VIEW_ORDER',             module: 'orders' },
  { method: 'POST',   pattern: /\/orders$/,                        action: 'CREATE_ORDER',           module: 'orders' },
  { method: 'PATCH',  pattern: /\/orders\/.*\/status/,             action: 'UPDATE_ORDER_STATUS',    module: 'orders' },
  // POS
  { method: 'POST',   pattern: /\/pos\/sale/,                      action: 'POS_SALE',               module: 'orders' },
  // PROCUREMENT
  { method: 'GET',    pattern: /\/purchase-orders$/,               action: 'VIEW_PURCHASE_ORDERS',   module: 'procurement' },
  { method: 'POST',   pattern: /\/purchase-orders$/,               action: 'CREATE_PURCHASE_ORDER',  module: 'procurement' },
  { method: 'PATCH',  pattern: /\/purchase-orders\/.*\/approve/,   action: 'APPROVE_PO',             module: 'procurement' },
  { method: 'PATCH',  pattern: /\/purchase-orders\/.*\/send/,      action: 'SEND_PO',                module: 'procurement' },
  { method: 'POST',   pattern: /\/purchase-orders\/.*\/receive/,   action: 'RECEIVE_PO',             module: 'procurement' },
  { method: 'POST',   pattern: /\/suppliers$/,                     action: 'CREATE_SUPPLIER',        module: 'procurement' },
  { method: 'PUT',    pattern: /\/suppliers\//,                    action: 'UPDATE_SUPPLIER',        module: 'procurement' },
  // ACCOUNTING
  { method: 'POST',   pattern: /\/accounts$/,                      action: 'CREATE_ACCOUNT',         module: 'accounting' },
  { method: 'POST',   pattern: /\/expenses$/,                      action: 'CREATE_EXPENSE',         module: 'accounting' },
  { method: 'PUT',    pattern: /\/expenses\//,                     action: 'UPDATE_EXPENSE',         module: 'accounting' },
  { method: 'DELETE', pattern: /\/expenses\//,                     action: 'DELETE_EXPENSE',         module: 'accounting' },
  { method: 'POST',   pattern: /\/journal-entries/,                action: 'CREATE_JOURNAL_ENTRY',   module: 'accounting' },
  { method: 'GET',    pattern: /\/accounting\//,                   action: 'VIEW_FINANCIAL_REPORT',  module: 'accounting' },
  // HR
  { method: 'POST',   pattern: /\/employees$/,                     action: 'CREATE_EMPLOYEE',        module: 'hr' },
  { method: 'POST',   pattern: /\/attendance/,                     action: 'MARK_ATTENDANCE',        module: 'hr' },
  { method: 'POST',   pattern: /\/leave-requests$/,                action: 'CREATE_LEAVE_REQUEST',   module: 'hr' },
  { method: 'PATCH',  pattern: /\/leave-requests\//,               action: 'UPDATE_LEAVE_REQUEST',   module: 'hr' },
  { method: 'POST',   pattern: /\/payroll$/,                       action: 'RUN_PAYROLL',            module: 'hr' },
  { method: 'PATCH',  pattern: /\/payroll\/.*\/approve/,           action: 'APPROVE_PAYROLL',        module: 'hr' },
  // CRM
  { method: 'POST',   pattern: /\/customers$/,                     action: 'CREATE_CUSTOMER',        module: 'crm' },
  { method: 'POST',   pattern: /\/leads$/,                         action: 'CREATE_LEAD',            module: 'crm' },
  { method: 'PATCH',  pattern: /\/leads\//,                        action: 'UPDATE_LEAD',            module: 'crm' },
  { method: 'POST',   pattern: /\/contact-history/,                action: 'LOG_CONTACT',            module: 'crm' },
  // REPORTS & DASHBOARD
  { method: 'GET',    pattern: /\/reports\//,                      action: 'VIEW_REPORT',            module: 'reports' },
  { method: 'GET',    pattern: /\/dashboard/,                      action: 'VIEW_DASHBOARD',         module: 'dashboard' },
  // PLATFORM
  { method: 'GET',    pattern: /\/platform\/tenants$/,             action: 'VIEW_ALL_TENANTS',       module: 'platform' },
  { method: 'GET',    pattern: /\/platform\/tenants\//,            action: 'VIEW_TENANT',            module: 'platform' },
  { method: 'PATCH',  pattern: /\/platform\/tenants\/.*\/suspend/, action: 'SUSPEND_TENANT',         module: 'platform' },
  { method: 'PATCH',  pattern: /\/platform\/tenants\/.*\/activate/,action: 'ACTIVATE_TENANT',        module: 'platform' },
  { method: 'PATCH',  pattern: /\/platform\/tenants\//,            action: 'UPDATE_TENANT',          module: 'platform' },
];

const SKIP = [/\/storefront\//, /\/auth\/me/, /\/notifications/, /\/audit-logs/, /\/health/, /\/pos\/products/, /\/categories$/, /\/ess\//];

const descriptions = {
  LOGIN:                (req) => `${req.user?.name} logged in`,
  CHANGE_PASSWORD:      (req) => `${req.user?.name} changed their password`,
  FORGOT_PASSWORD:      (req) => `Password reset requested for ${req.body?.email}`,
  RESET_PASSWORD:       (req) => `Password was reset`,
  VIEW_USERS:           (req) => `${req.user?.name} viewed users list`,
  CREATE_USER:          (req) => `${req.user?.name} created user "${req.body?.name}" (${req.body?.role})`,
  UPDATE_USER:          (req) => `${req.user?.name} updated a user`,
  DEACTIVATE_USER:      (req) => `${req.user?.name} deactivated a user`,
  VIEW_BRANCHES:        (req) => `${req.user?.name} viewed branches`,
  CREATE_BRANCH:        (req) => `${req.user?.name} created branch "${req.body?.name}"`,
  UPDATE_BRANCH:        (req) => `${req.user?.name} updated a branch`,
  DELETE_BRANCH:        (req) => `${req.user?.name} deactivated a branch`,
  VIEW_PRODUCTS:        (req) => `${req.user?.name} viewed products list`,
  VIEW_PRODUCT:         (req) => `${req.user?.name} viewed a product`,
  CREATE_PRODUCT:       (req) => `${req.user?.name} added product "${req.body?.name}" (SKU: ${req.body?.sku || 'auto'})`,
  UPDATE_PRODUCT:       (req) => `${req.user?.name} updated a product`,
  DELETE_PRODUCT:       (req) => `${req.user?.name} deleted a product`,
  ADJUST_STOCK:         (req) => `${req.user?.name} adjusted stock by ${req.body?.quantity > 0 ? '+' : ''}${req.body?.quantity}`,
  CREATE_CATEGORY:      (req) => `${req.user?.name} created category "${req.body?.name}"`,
  VIEW_ORDERS:          (req) => `${req.user?.name} viewed orders`,
  VIEW_ORDER:           (req) => `${req.user?.name} viewed an order`,
  CREATE_ORDER:         (req) => `${req.user?.name} created order for "${req.body?.customer_name}"`,
  UPDATE_ORDER_STATUS:  (req) => `${req.user?.name} updated order status to "${req.body?.status}"`,
  POS_SALE:             (req) => `${req.user?.name} processed POS sale for "${req.body?.customer_name || 'Walk-in'}" — ${req.body?.items?.length || 0} item(s)`,
  VIEW_PURCHASE_ORDERS: (req) => `${req.user?.name} viewed purchase orders`,
  CREATE_PURCHASE_ORDER:(req) => `${req.user?.name} created a purchase order`,
  APPROVE_PO:           (req) => `${req.user?.name} approved a purchase order`,
  SEND_PO:              (req) => `${req.user?.name} sent a purchase order to supplier`,
  RECEIVE_PO:           (req) => `${req.user?.name} received goods for a purchase order`,
  CREATE_SUPPLIER:      (req) => `${req.user?.name} added supplier "${req.body?.name}"`,
  UPDATE_SUPPLIER:      (req) => `${req.user?.name} updated a supplier`,
  CREATE_ACCOUNT:       (req) => `${req.user?.name} created account "${req.body?.name}"`,
  CREATE_EXPENSE:       (req) => `${req.user?.name} logged expense "${req.body?.title}" — GHS ${req.body?.amount}`,
  UPDATE_EXPENSE:       (req) => `${req.user?.name} updated an expense`,
  DELETE_EXPENSE:       (req) => `${req.user?.name} deleted an expense`,
  CREATE_JOURNAL_ENTRY: (req) => `${req.user?.name} created journal entry "${req.body?.description}"`,
  VIEW_FINANCIAL_REPORT:(req) => `${req.user?.name} viewed a financial report`,
  CREATE_EMPLOYEE:      (req) => `${req.user?.name} added employee "${req.body?.name}"`,
  MARK_ATTENDANCE:      (req) => `${req.user?.name} marked attendance`,
  CREATE_LEAVE_REQUEST: (req) => `${req.user?.name} submitted a leave request`,
  UPDATE_LEAVE_REQUEST: (req) => `${req.user?.name} updated a leave request`,
  RUN_PAYROLL:          (req) => `${req.user?.name} ran payroll`,
  APPROVE_PAYROLL:      (req) => `${req.user?.name} approved payroll`,
  CREATE_CUSTOMER:      (req) => `${req.user?.name} added customer "${req.body?.name}"`,
  CREATE_LEAD:          (req) => `${req.user?.name} created lead "${req.body?.title}"`,
  UPDATE_LEAD:          (req) => `${req.user?.name} updated a lead`,
  LOG_CONTACT:          (req) => `${req.user?.name} logged a ${req.body?.type || 'contact'} activity`,
  VIEW_REPORT:          (req) => `${req.user?.name} viewed a report (${req.path.split('/').pop()})`,
  VIEW_DASHBOARD:       (req) => `${req.user?.name} viewed the dashboard`,
  VIEW_ALL_TENANTS:     (req) => `${req.user?.name} viewed all tenants`,
  VIEW_TENANT:          (req) => `${req.user?.name} viewed a tenant`,
  SUSPEND_TENANT:       (req) => `${req.user?.name} suspended a tenant`,
  ACTIVATE_TENANT:      (req) => `${req.user?.name} activated a tenant`,
  UPDATE_TENANT:        (req) => `${req.user?.name} updated tenant settings`,
};

const auditMiddleware = (req, res, next) => {
  if (!req.user) return next();
  if (SKIP.some(p => p.test(req.path))) return next();

  const match = routeMap.find(r => r.method === req.method && r.pattern.test(req.path));
  if (!match) return next();

  const originalJson = res.json.bind(res);
  res.json = function (body) {
    const status = body?.success === false ? 'failed' : 'success';
    const descFn  = descriptions[match.action];
    const description = descFn ? descFn(req) : `${req.user?.name} performed ${match.action}`;

    AuditLog.create({
      tenant_id:   req.tenant_id || req.user?.tenant_id || null,
      branch_id:   req.user?.branch_id || null,
      user_id:     req.user?._id,
      user_name:   req.user?.name,
      user_email:  req.user?.email,
      user_role:   req.user?.role,
      action:      match.action,
      module:      match.module,
      description,
      metadata:    {
        path:          req.path,
        method:        req.method,
        ...(req.body?.name            && { name: req.body.name }),
        ...(req.body?.customer_name   && { customer_name: req.body.customer_name }),
        ...(req.body?.status          && { status: req.body.status }),
        ...(req.body?.quantity        && { quantity: req.body.quantity }),
        ...(req.body?.amount          && { amount: req.body.amount }),
        ...(req.params?.id            && { record_id: req.params.id }),
      },
      ip:     req.ip || req.headers['x-forwarded-for'] || null,
      status,
    }).catch(() => {});

    return originalJson(body);
  };

  next();
};

module.exports = auditMiddleware;
