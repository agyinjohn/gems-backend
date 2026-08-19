module.exports = {
  // ── FINANCIAL STATEMENTS ───────────────────────────────────────────────────
  '/accounting/pl': {
    get: {
      tags: ['Accounting'],
      summary: 'Profit & Loss statement',
      parameters: [
        { name: 'from',   in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',     in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'period', in: 'query', schema: { type: 'string', enum: ['mtd', 'ytd', 'custom'] } },
        { name: 'source', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'P&L with revenue, expenses and net income' } },
    },
  },

  '/accounting/balance-sheet': {
    get: {
      tags: ['Accounting'],
      summary: 'Balance sheet as of a date',
      parameters: [
        { name: 'as_of', in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: { 200: { description: 'Balance sheet with assets, liabilities and equity' } },
    },
  },

  '/accounting/cashflow': {
    get: {
      tags: ['Accounting'],
      summary: 'Cash flow statement',
      parameters: [
        { name: 'from',   in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',     in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'period', in: 'query', schema: { type: 'string', enum: ['mtd', 'ytd', 'custom'] } },
      ],
      responses: { 200: { description: 'Cash flow with operating, investing and financing sections' } },
    },
  },

  '/accounting/trial-balance': {
    get: {
      tags: ['Accounting'],
      summary: 'Trial balance as of a date',
      parameters: [
        { name: 'as_of', in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: { 200: { description: 'Trial balance with debit and credit totals per account' } },
    },
  },

  '/accounting/vat-return': {
    get: {
      tags: ['Accounting'],
      summary: 'VAT return summary',
      parameters: [
        { name: 'from',   in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',     in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'period', in: 'query', schema: { type: 'string', enum: ['mtd', 'ytd', 'custom'] } },
      ],
      responses: { 200: { description: 'VAT collected, VAT paid and net VAT payable' } },
    },
  },

  '/accounting/tax': {
    get: {
      tags: ['Accounting'],
      summary: 'Tax summary (all tax types)',
      parameters: [
        { name: 'from',   in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',     in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'period', in: 'query', schema: { type: 'string', enum: ['mtd', 'ytd', 'custom'] } },
      ],
      responses: { 200: { description: 'Tax breakdown by type' } },
    },
  },

  '/accounting/summary': {
    get: {
      tags: ['Accounting'],
      summary: 'Accounting overview KPIs (revenue, expenses, net income, cash)',
      parameters: [
        { name: 'period', in: 'query', schema: { type: 'string', enum: ['mtd', 'ytd', 'all'], default: 'ytd' } },
      ],
      responses: { 200: { description: 'Accounting KPI summary' } },
    },
  },

  // ── RECEIVABLES & PAYABLES ─────────────────────────────────────────────────
  '/accounting/receivables': {
    get: {
      tags: ['Accounting'],
      summary: 'Accounts receivable aging report',
      parameters: [
        { name: 'search',       in: 'query', schema: { type: 'string' } },
        { name: 'status',       in: 'query', schema: { type: 'string' } },
        { name: 'aging_bucket', in: 'query', schema: { type: 'string', enum: ['current', '1-30', '31-60', '61-90', '90+'] } },
        { name: 'customer_id',  in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Receivables with aging buckets and totals' } },
    },
  },

  '/accounting/payables': {
    get: {
      tags: ['Accounting'],
      summary: 'Accounts payable aging report',
      parameters: [
        { name: 'search',       in: 'query', schema: { type: 'string' } },
        { name: 'source',       in: 'query', schema: { type: 'string' } },
        { name: 'aging_bucket', in: 'query', schema: { type: 'string', enum: ['current', '1-30', '31-60', '61-90', '90+'] } },
      ],
      responses: { 200: { description: 'Payables with aging buckets and totals' } },
    },
  },

  '/accounting/ap-ledger': {
    get: {
      tags: ['Accounting'],
      summary: 'AP ledger — GL-derived accounts payable. Pass ?view=full for full detail',
      parameters: [
        { name: 'view',         in: 'query', schema: { type: 'string', enum: ['full'] } },
        { name: 'search',       in: 'query', schema: { type: 'string' } },
        { name: 'source',       in: 'query', schema: { type: 'string' } },
        { name: 'aging_bucket', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'AP ledger entries with outstanding totals' } },
    },
  },

  // ── BANK RECONCILIATION ────────────────────────────────────────────────────
  '/accounting/reconciliations': {
    get: {
      tags: ['Accounting'],
      summary: 'List bank reconciliation sessions',
      parameters: [
        { name: 'view', in: 'query', schema: { type: 'string', enum: ['full'] } },
      ],
      responses: { 200: { description: 'Array of reconciliation sessions' } },
    },
    post: {
      tags: ['Accounting'],
      summary: 'Create a new reconciliation session',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                account_id:       { type: 'string', description: 'Defaults to cash account (1001)' },
                statement_date:   { type: 'string', format: 'date' },
                opening_balance:  { type: 'number' },
                closing_balance:  { type: 'number' },
                from:             { type: 'string', format: 'date' },
                to:               { type: 'string', format: 'date' },
                bank_lines:       { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Reconciliation session created' } },
    },
  },

  '/accounting/reconciliations/{id}': {
    get: {
      tags: ['Accounting'],
      summary: 'Get reconciliation session detail',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Session with matched pairs and stats' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    put: {
      tags: ['Accounting'],
      summary: 'Update reconciliation session (draft only)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated session' } },
    },
  },

  '/accounting/reconciliations/{id}/complete': {
    patch: {
      tags: ['Accounting'],
      summary: 'Mark reconciliation session as completed',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Session completed with final stats' } },
    },
  },

  '/accounting/reconcile': {
    post: {
      tags: ['Accounting'],
      summary: 'Run a one-shot bank reconciliation (legacy)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                account_id:      { type: 'string' },
                lines:           { type: 'array', items: { type: 'object' } },
                from:            { type: 'string', format: 'date' },
                to:              { type: 'string', format: 'date' },
                opening_balance: { type: 'number' },
                closing_balance: { type: 'number' },
                statement_date:  { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Reconciliation result' } },
    },
  },

  '/accounting/reconcile/import': {
    post: {
      tags: ['Accounting'],
      summary: 'Import bank statement rows and run reconciliation',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['rows'],
              properties: {
                rows:            { type: 'array', items: { type: 'object' } },
                account_id:      { type: 'string' },
                opening_balance: { type: 'number' },
                closing_balance: { type: 'number' },
                statement_date:  { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Reconciliation result with imported row count' } },
    },
  },

  '/accounting/reconciliation': {
    get: {
      tags: ['Accounting'],
      summary: 'Get reconciliation overview (legacy single-view)',
      responses: { 200: { description: 'Reconciliation summary' } },
    },
  },

  // ── DEPRECIATION ───────────────────────────────────────────────────────────
  '/accounting/depreciation/run': {
    post: {
      tags: ['Accounting'],
      summary: 'Run depreciation for all active assets',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                month: { type: 'integer', minimum: 1, maximum: 12 },
                year:  { type: 'integer' },
                rate:  { type: 'number', default: 0.1, description: 'Annual depreciation rate, e.g. 0.1 = 10%' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Depreciation entries posted per asset' } },
    },
  },

  // ── EXPORTS ────────────────────────────────────────────────────────────────
  '/accounting/export/quickbooks': {
    get: {
      tags: ['Accounting'],
      summary: 'Export journal entries in QuickBooks CSV format',
      parameters: [
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',   in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: {
        200: {
          description: 'QuickBooks-compatible CSV file',
          content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
        },
      },
    },
  },

  '/accounting/export/xero': {
    get: {
      tags: ['Accounting'],
      summary: 'Export journal entries in Xero CSV format',
      parameters: [
        { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',   in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: {
        200: {
          description: 'Xero-compatible CSV file',
          content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
        },
      },
    },
  },

  // ── PAYMENT LOGS ───────────────────────────────────────────────────────────
  '/payment-logs': {
    get: {
      tags: ['Accounting'],
      summary: 'List payment logs with source summary',
      parameters: [
        { name: 'source', in: 'query', schema: { type: 'string' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['success', 'failed', 'pending'] } },
        { name: 'from',   in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',     in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'page',   in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit',  in: 'query', schema: { type: 'integer', default: 50 } },
      ],
      responses: { 200: { description: 'Paginated payment logs with aggregate summary by source' } },
    },
  },
};
