/**
 * What a custom role may reach on the API.
 *
 * Custom roles are built from pages (see the frontend's lib/pagePermissions.ts)
 * and a handful of action keys. This turns those into API access so the rules
 * hold when somebody skips the UI and calls an endpoint directly.
 *
 * An API prefix is reachable when the role holds at least one of the pages that
 * use it. Writing additionally needs the module's action key where there is
 * one (crm.manage, hr.payroll, ...). A path no rule covers is refused — a new
 * endpoint is closed to custom roles until it is listed here.
 *
 * Roles saved before page-level access carry module keys ("hr.view") instead
 * of page keys and no PAGES_V2 marker; their `legacy` key keeps them working.
 */
const PAGES_V2 = 'pages.v2';

const RULES = [
  // ── Open to every signed-in user ─────────────────────────────────────────
  { prefixes: ['/auth', '/tasks', '/notifications', '/my-tenant', '/plan-prices', '/chat', '/marketplace', '/billing/status'], open: true },
  // Pick-lists other screens need to render.
  { prefixes: ['/branches', '/departments', '/categories', '/locations'], openRead: true },
  { prefixes: ['/branches'], pages: ['/branches'], legacy: ['branches.manage'] },
  { prefixes: ['/departments'], pages: ['/hr/*', '/departments'], legacy: ['hr.view'], action: 'hr.manage' },

  // ── Sales ────────────────────────────────────────────────────────────────
  { prefixes: ['/pos'], pages: ['/pos', '/pos/shifts'], legacy: ['pos.view'] },
  { prefixes: ['/orders', '/coupons', '/promotions', '/banners', '/print-requests', '/service-requests', '/reviews'],
    pages: ['/orders', '/service-requests', '/reviews', '/store-settings'], readPages: ['/pos', '/crm', '/daily-sales', '/jobs'], legacy: ['orders.view'], action: 'orders.manage' },
  { prefixes: ['/daily-sales', '/reports'], pages: ['/reports', '/daily-sales'], legacy: ['reports.view'] },
  { prefixes: ['/dashboard'], pages: ['/dashboard'], legacy: ['dashboard.view'] },

  // ── Stock ────────────────────────────────────────────────────────────────
  { prefixes: ['/products', '/product-info', '/stock-movements', '/inventory', '/categories', '/locations', '/asset-categories', '/assets'],
    pages: ['/inventory', '/assets', '/service-catalog'],
    readPages: ['/pos', '/orders', '/procurement', '/store-settings', '/projects', '/jobs', '/contracts', '/crm', '/service-requests'],
    legacy: ['inventory.view'], action: 'inventory.manage' },
  { prefixes: ['/purchase-orders', '/suppliers'], pages: ['/procurement'], readPages: ['/inventory', '/accounting/*'], legacy: ['procurement.view'], action: 'procurement.manage' },

  // ── Customers & work ─────────────────────────────────────────────────────
  { prefixes: ['/customers', '/leads', '/contact-history'], pages: ['/crm'],
    readPages: ['/orders', '/pos', '/projects', '/contracts', '/jobs', '/service-requests', '/accounting/*'], legacy: ['crm.view'], action: 'crm.manage' },
  { prefixes: ['/sms', '/email'], pages: ['/messaging', '/crm'], action: null },
  { prefixes: ['/projects', '/contracts', '/jobs', '/labour'], pages: ['/projects', '/contracts', '/jobs', '/labour'] },

  // ── People ───────────────────────────────────────────────────────────────
  { prefixes: ['/payroll', '/loans'], pages: ['/hr/*'], legacy: ['hr.view'], action: 'hr.payroll' },
  { prefixes: ['/employees', '/appraisals', '/leave-types', '/leave-requests', '/holidays', '/attendance', '/hr'],
    pages: ['/hr/*'], readPages: ['/projects'], legacy: ['hr.view'], action: 'hr.manage' },
  { prefixes: ['/ess'], pages: ['/ess'], legacy: ['ess.view'] },

  // ── Money ────────────────────────────────────────────────────────────────
  { prefixes: ['/accounting', '/accounts', '/budgets', '/credit-notes', '/expenses', '/invoices', '/journal-entries', '/tax-rates', '/vendor-bills', '/payment-logs', '/refunds'],
    pages: ['/accounting/*', '/payment-logs', '/refunds', '/approvals'], readPages: ['/orders', '/projects', '/contracts'], legacy: ['accounting.view'], action: 'accounting.manage' },
  { prefixes: ['/payouts', '/payout-methods', '/paystack'], pages: ['/payouts'] },

  // ── Settings ─────────────────────────────────────────────────────────────
  { prefixes: ['/storefront/settings', '/storefront/domain'], pages: ['/store-settings'], legacy: ['branches.manage'] },
  { prefixes: ['/billing'], pages: ['/billing'], legacy: ['billing.view'] },
  { prefixes: ['/audit-logs'], pages: ['/activity'] },
];

const matches = (apiPath, prefix) => apiPath === prefix || apiPath.startsWith(prefix + '/');
const longest = (apiPath, rule) => Math.max(...rule.prefixes.filter((p) => matches(apiPath, p)).map((p) => p.length), -1);

function holdsPage(perms, page) {
  return page.endsWith('/*')
    ? perms.some((p) => p.startsWith(`page:${page.slice(0, -1)}`))
    : perms.includes(`page:${page}`);
}

function holdsAny(perms, pages = [], legacy = []) {
  if (pages.some((p) => holdsPage(perms, p))) return true;
  return !perms.includes(PAGES_V2) && legacy.some((l) => perms.includes(l));
}

/**
 * @param {string[]} perms   the custom role's permission keys
 * @param {string}   method  HTTP method
 * @param {string}   apiPath the path after /api, query string allowed
 */
function customRoleAllows(perms, method, apiPath) {
  const path = String(apiPath || '').split('?')[0].replace(/\/+$/, '') || '/';
  const isRead = method === 'GET' || method === 'HEAD';

  // The most specific prefix decides. Rules sharing that prefix (a pick-list
  // that anyone may read, and the page that owns writes) are each given a say.
  const best = Math.max(...RULES.map((r) => longest(path, r)));
  if (best < 0) return false;
  const tied = RULES.filter((r) => longest(path, r) === best);

  return tied.some((r) => {
    if (r.open) return true;
    if (isRead && r.openRead) return true;
    const pages = isRead ? [...(r.pages || []), ...(r.readPages || [])] : (r.pages || []);
    if (!holdsAny(perms, pages, r.legacy)) return false;
    return isRead || !r.action || perms.includes(r.action);
  });
}

module.exports = { customRoleAllows, PAGES_V2 };
