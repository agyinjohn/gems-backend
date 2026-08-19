module.exports = {
  '/reports/branches': {
    get: {
      tags: ['Reports'],
      summary: 'List branches available for report filtering',
      responses: { 200: { description: 'Array of branches' } },
    },
  },

  '/reports/overview': {
    get: {
      tags: ['Reports'],
      summary: 'Business overview report',
      parameters: [
        { name: 'branch_id', in: 'query', schema: { type: 'string' } },
        { name: 'from',      in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',        in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: { 200: { description: 'Overview KPIs across all modules' } },
    },
  },

  '/reports/sales': {
    get: {
      tags: ['Reports'],
      summary: 'Sales report',
      parameters: [
        { name: 'branch_id', in: 'query', schema: { type: 'string' } },
        { name: 'from',      in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',        in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'group_by',  in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } },
      ],
      responses: { 200: { description: 'Sales totals, top products, channel breakdown' } },
    },
  },

  '/reports/inventory': {
    get: {
      tags: ['Reports'],
      summary: 'Inventory report',
      parameters: [
        { name: 'branch_id',  in: 'query', schema: { type: 'string' } },
        { name: 'low_stock',  in: 'query', schema: { type: 'boolean' } },
      ],
      responses: { 200: { description: 'Stock levels, low stock alerts, movement summary' } },
    },
  },

  '/reports/finance': {
    get: {
      tags: ['Reports'],
      summary: 'Finance report',
      parameters: [
        { name: 'branch_id', in: 'query', schema: { type: 'string' } },
        { name: 'from',      in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',        in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: { 200: { description: 'Revenue, expenses, profit, cash position' } },
    },
  },

  '/reports/hr': {
    get: {
      tags: ['Reports'],
      summary: 'HR report',
      parameters: [
        { name: 'branch_id', in: 'query', schema: { type: 'string' } },
        { name: 'from',      in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',        in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: { 200: { description: 'Headcount, attendance, leave, payroll summary' } },
    },
  },

  '/reports/procurement': {
    get: {
      tags: ['Reports'],
      summary: 'Procurement report',
      parameters: [
        { name: 'branch_id', in: 'query', schema: { type: 'string' } },
        { name: 'from',      in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',        in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: { 200: { description: 'PO totals, supplier spend, pending approvals' } },
    },
  },

  '/reports/crm': {
    get: {
      tags: ['Reports'],
      summary: 'CRM report',
      parameters: [
        { name: 'branch_id', in: 'query', schema: { type: 'string' } },
        { name: 'from',      in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',        in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: { 200: { description: 'Lead pipeline, conversion rate, contact activity' } },
    },
  },
};
