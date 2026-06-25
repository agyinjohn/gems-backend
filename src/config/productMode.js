/**
 * Product deployment mode — controls which API surface is exposed.
 * Set PRODUCT_MODE=pos|storefront|accounting|full (default: full)
 */
const VALID_MODES = ['full', 'pos', 'storefront', 'accounting'];

const MODE = (process.env.PRODUCT_MODE || 'full').toLowerCase();

const PUBLIC_PREFIXES = [
  '/auth/',
  '/auth/login',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/tenants/register',
  '/plan-prices',
  '/billing/callback',
  '/storefront/',
  '/webhooks/',
  '/product-info',
];

const ALLOWED_BY_MODE = {
  pos: [
    '/auth/', '/my-tenant', '/billing/', '/plan-prices',
    '/pos/', '/products', '/categories', '/orders', '/payment-logs',
    '/reports/', '/branches', '/users', '/roles', '/dashboard', '/audit-logs',
    '/chat/',
  ],
  storefront: [
    '/auth/', '/my-tenant', '/billing/', '/plan-prices',
    '/storefront/', '/products', '/categories', '/orders',
    '/coupons', '/branches', '/users', '/roles', '/dashboard', '/audit-logs',
    '/chat/',
  ],
  accounting: [
    '/auth/', '/my-tenant', '/billing/', '/plan-prices',
    '/accounts', '/expenses', '/journal-entries', '/accounting/',
    '/invoices', '/credit-notes', '/tax-rates', '/budgets',
    '/payment-logs', '/users', '/roles', '/dashboard', '/audit-logs',
    '/approvals', '/reports/', '/chat/',
  ],
};

function getProductMode() {
  return VALID_MODES.includes(MODE) ? MODE : 'full';
}

function isRouteAllowed(path, mode = getProductMode()) {
  if (mode === 'full') return true;
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p) || path === p.replace(/\/$/, ''))) return true;

  const allowed = ALLOWED_BY_MODE[mode] || [];
  return allowed.some((prefix) => path.startsWith(prefix) || path === prefix.replace(/\/$/, ''));
}

function getModeMeta(mode = getProductMode()) {
  const labels = {
    full: 'GEMS ERP (Full)',
    pos: 'GEMS POS',
    storefront: 'GEMS Store',
    accounting: 'GEMS Accounting',
  };
  return {
    mode,
    label: labels[mode] || labels.full,
    is_restricted: mode !== 'full',
    allowed_api_prefixes: mode === 'full' ? null : ALLOWED_BY_MODE[mode],
  };
}

module.exports = { getProductMode, isRouteAllowed, getModeMeta, VALID_MODES };
