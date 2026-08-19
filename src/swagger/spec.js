const spec = {
  openapi: '3.0.3',
  info: {
    title: 'GEMS ERP API',
    version: '1.0.0',
    description: 'Multi-tenant ERP system — GEMS. Base URL: `/api`',
  },
  servers: [
    { url: 'http://localhost:5000/api', description: 'Local' },
    { url: 'https://your-render-app.onrender.com/api', description: 'Production' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Success: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: true },
          data: { type: 'object' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          message: { type: 'string' },
        },
      },
    },
    responses: {
      Unauthorized: {
        description: 'Missing or invalid token',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Resource not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      BadRequest: {
        description: 'Validation error',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Auth',        description: 'Authentication & session' },
    { name: 'Tenants',     description: 'Tenant registration & platform admin management' },
    { name: 'Branches',    description: 'Branch management' },
    { name: 'Users',       description: 'User management (business owner only)' },
    { name: 'Roles',       description: 'Custom role management' },
    { name: 'Billing',     description: 'Subscription & billing' },
    { name: 'Platform',    description: 'Platform admin settings' },
    { name: 'Dashboard',   description: 'Dashboard summary' },
    { name: 'Inventory',   description: 'Products, categories & stock' },
    { name: 'POS',         description: 'Point of sale — sales, shifts, Paystack, display' },
    { name: 'Orders',      description: 'Internal & storefront orders' },
    { name: 'Storefront',  description: 'Public storefront, cart & checkout' },
    { name: 'Procurement', description: 'Suppliers & purchase orders' },
    { name: 'HR',          description: 'Employees, attendance, leave, payroll' },
    { name: 'ESS',         description: 'Employee self-service' },
    { name: 'CRM',         description: 'Customers, leads & contact history' },
    { name: 'Accounting',  description: 'Chart of accounts, expenses, journals, invoices' },
    { name: 'Reports',     description: 'Analytics & report exports' },
    { name: 'Projects',    description: 'Project & contract management' },
    { name: 'SMS',         description: 'SMS credits & templates' },
    { name: 'Email',       description: 'Email settings & templates' },
    { name: 'Assets',      description: 'Fixed assets & locations' },
    { name: 'Misc',        description: 'Notifications, audit logs, webhooks, chat' },
  ],
  paths: {},
};

// Paths are merged in by each phase file
const auth        = require('./paths/auth');
const tenants     = require('./paths/tenants');
const branches    = require('./paths/branches');
const users       = require('./paths/users');
const billing     = require('./paths/billing');
const platform    = require('./paths/platform');
const dashboard   = require('./paths/dashboard');
const inventory   = require('./paths/inventory');
const pos         = require('./paths/pos');
const orders      = require('./paths/orders');
const storefront  = require('./paths/storefront');
const procurement = require('./paths/procurement');
const hr          = require('./paths/hr');
const ess         = require('./paths/ess');
const crm         = require('./paths/crm');
const acc_accounts = require('./paths/accounting_accounts');
const acc_journals = require('./paths/accounting_journals');
const acc_bills    = require('./paths/accounting_bills');
const acc_reports  = require('./paths/accounting_reports');
const reports     = require('./paths/reports');
const projects    = require('./paths/projects');
const contracts   = require('./paths/contracts');
const sms         = require('./paths/sms');
const email       = require('./paths/email');
const assets      = require('./paths/assets');
const misc        = require('./paths/misc');

Object.assign(spec.paths, auth, tenants, branches, users, billing, platform, dashboard, inventory, pos, orders, storefront, procurement, hr, ess, crm, acc_accounts, acc_journals, acc_bills, acc_reports, reports, projects, contracts, sms, email, assets, misc);

module.exports = spec;
