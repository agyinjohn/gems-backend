module.exports = {
  // ── VENDOR BILLS ───────────────────────────────────────────────────────────
  '/vendor-bills': {
    get: {
      tags: ['Accounting'],
      summary: 'List vendor bills. Pass ?view=full for enriched view',
      parameters: [
        { name: 'view',         in: 'query', schema: { type: 'string', enum: ['full'] } },
        { name: 'status',       in: 'query', schema: { type: 'string' } },
        { name: 'search',       in: 'query', schema: { type: 'string' } },
        { name: 'aging_bucket', in: 'query', schema: { type: 'string', enum: ['current', '1-30', '31-60', '61-90', '90+'] } },
      ],
      responses: { 200: { description: 'Array of vendor bills' } },
    },
    post: {
      tags: ['Accounting'],
      summary: 'Create vendor bill (draft)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['vendor_name', 'due_date', 'lines'],
              properties: {
                vendor_name:        { type: 'string' },
                supplier_id:        { type: 'string' },
                issue_date:         { type: 'string', format: 'date' },
                due_date:           { type: 'string', format: 'date' },
                notes:              { type: 'string' },
                expense_account_id: { type: 'string' },
                lines: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['description', 'unit_price'],
                    properties: {
                      description: { type: 'string' },
                      quantity:    { type: 'number', default: 1 },
                      unit_price:  { type: 'number' },
                      tax_rate:    { type: 'number', default: 0 },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Vendor bill created in draft status' } },
    },
  },

  '/vendor-bills/{id}/post': {
    patch: {
      tags: ['Accounting'],
      summary: 'Post vendor bill — moves draft → posted and creates AP GL entry',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Bill posted, GL entry created' },
        400: { description: 'Only draft bills can be posted' },
      },
    },
  },

  '/vendor-bills/{id}/payments': {
    post: {
      tags: ['Accounting'],
      summary: 'Record a payment against a vendor bill',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['amount'],
              properties: {
                amount:    { type: 'number' },
                method:    { type: 'string', enum: ['cash', 'bank_transfer', 'momo', 'cheque'], default: 'bank_transfer' },
                reference: { type: 'string' },
                note:      { type: 'string' },
                date:      { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Payment recorded, bill status updated' } },
    },
  },

  '/vendor-bills/{id}/void': {
    patch: {
      tags: ['Accounting'],
      summary: 'Void vendor bill and reverse GL entry',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Bill voided' },
        400: { description: 'Cannot void a bill with payments recorded' },
      },
    },
  },

  // ── TAX RATES ──────────────────────────────────────────────────────────────
  '/tax-rates': {
    get: {
      tags: ['Accounting'],
      summary: 'List tax rates',
      responses: { 200: { description: 'Array of tax rates' } },
    },
    post: {
      tags: ['Accounting'],
      summary: 'Create tax rate (business owner / accountant)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'rate'],
              properties: {
                name:       { type: 'string', example: 'VAT 15%' },
                rate:       { type: 'number', example: 15 },
                applies_to: { type: 'string', enum: ['sales', 'purchases', 'both'], default: 'both' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Tax rate created' } },
    },
  },

  '/tax-rates/{id}': {
    put: {
      tags: ['Accounting'],
      summary: 'Update tax rate',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated tax rate' } },
    },
    delete: {
      tags: ['Accounting'],
      summary: 'Delete tax rate',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  // ── BUDGETS ────────────────────────────────────────────────────────────────
  '/budgets': {
    get: {
      tags: ['Accounting'],
      summary: 'List budgets',
      parameters: [
        { name: 'period',      in: 'query', schema: { type: 'string', example: '2025-01' } },
        { name: 'period_type', in: 'query', schema: { type: 'string', enum: ['monthly', 'quarterly', 'annual'] } },
      ],
      responses: { 200: { description: 'Array of budgets' } },
    },
    post: {
      tags: ['Accounting'],
      summary: 'Create or upsert a budget entry',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['category', 'period', 'amount'],
              properties: {
                category:    { type: 'string', example: 'marketing' },
                period:      { type: 'string', example: '2025-01' },
                period_type: { type: 'string', enum: ['monthly', 'quarterly', 'annual'], default: 'monthly' },
                amount:      { type: 'number' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Budget created or updated' } },
    },
  },

  '/budgets/vs-actual': {
    get: {
      tags: ['Accounting'],
      summary: 'Get budget vs actual spend comparison',
      parameters: [
        { name: 'period',      in: 'query', schema: { type: 'string' } },
        { name: 'period_type', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Budget vs actual data' } },
    },
  },

  '/budgets/{id}': {
    put: {
      tags: ['Accounting'],
      summary: 'Update budget amount',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['amount'],
              properties: { amount: { type: 'number' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated budget' } },
    },
    delete: {
      tags: ['Accounting'],
      summary: 'Delete budget entry',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  // ── ACCOUNTING PERIODS ─────────────────────────────────────────────────────
  '/accounting/periods': {
    get: {
      tags: ['Accounting'],
      summary: 'List accounting periods',
      responses: { 200: { description: 'Array of accounting periods' } },
    },
    post: {
      tags: ['Accounting'],
      summary: 'Create accounting period',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'start_date', 'end_date'],
              properties: {
                name:       { type: 'string', example: 'January 2025' },
                type:       { type: 'string', enum: ['month', 'quarter', 'year'], default: 'month' },
                start_date: { type: 'string', format: 'date' },
                end_date:   { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Period created' },
        400: { description: 'Overlaps with an existing open period' },
      },
    },
  },

  '/accounting/periods/{id}/close': {
    patch: {
      tags: ['Accounting'],
      summary: 'Close an accounting period',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Period closed' },
        400: { description: 'Unbalanced journal entries exist in this period' },
      },
    },
  },

  '/accounting/periods/{id}/reopen': {
    patch: {
      tags: ['Accounting'],
      summary: 'Reopen a closed period (business owner only)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Period reopened' } },
    },
  },

  '/accounting/periods/{id}/year-end-close': {
    post: {
      tags: ['Accounting'],
      summary: 'Post year-end closing entries — zeros revenue & expense into Retained Earnings',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Year-end closing entries posted with net income summary' },
        400: { description: 'Period not closed or entries already posted' },
      },
    },
  },
};
