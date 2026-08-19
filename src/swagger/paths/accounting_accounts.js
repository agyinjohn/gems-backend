module.exports = {
  // ── CHART OF ACCOUNTS ──────────────────────────────────────────────────────
  '/accounts': {
    get: {
      tags: ['Accounting'],
      summary: 'List accounts. Pass ?view=coa for full chart of accounts tree',
      parameters: [
        { name: 'view',           in: 'query', schema: { type: 'string', enum: ['coa'] } },
        { name: 'include_groups', in: 'query', schema: { type: 'boolean', default: true } },
        { name: 'active_only',    in: 'query', schema: { type: 'boolean', default: true } },
        { name: 'type',           in: 'query', schema: { type: 'string', enum: ['asset', 'liability', 'equity', 'revenue', 'expense'] } },
        { name: 'search',         in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of accounts with GL balances' } },
    },
    post: {
      tags: ['Accounting'],
      summary: 'Create account (business owner / accountant)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['code', 'name', 'type'],
              properties: {
                code:            { type: 'string', example: '1010' },
                name:            { type: 'string', example: 'Petty Cash' },
                type:            { type: 'string', enum: ['asset', 'liability', 'equity', 'revenue', 'expense'] },
                description:     { type: 'string' },
                opening_balance: { type: 'number' },
                parent_id:       { type: 'string', description: 'ID of a group account' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Account created, opening balance entry posted if provided' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/accounts/{id}': {
    put: {
      tags: ['Accounting'],
      summary: 'Update account name / type / opening balance',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name:            { type: 'string' },
                type:            { type: 'string' },
                description:     { type: 'string' },
                opening_balance: { type: 'number' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated account' } },
    },
  },

  '/accounts/{id}/active': {
    patch: {
      tags: ['Accounting'],
      summary: 'Activate or deactivate an account',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['is_active'],
              properties: { is_active: { type: 'boolean' } },
            },
          },
        },
      },
      responses: {
        200: { description: 'Account active status updated' },
        400: { description: 'Cannot deactivate account with non-zero balance' },
      },
    },
  },

  '/accounting/gl/{accountId}': {
    get: {
      tags: ['Accounting'],
      summary: 'Get general ledger activity for a single account',
      parameters: [{ name: 'accountId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Account ledger with transaction lines' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  '/accounting/seed-coa': {
    post: {
      tags: ['Accounting'],
      summary: 'Seed / update chart of accounts with standard accounts',
      responses: { 200: { description: 'Chart of accounts updated' } },
    },
  },

  // ── EXPENSES ───────────────────────────────────────────────────────────────
  '/expenses': {
    get: {
      tags: ['Accounting'],
      summary: 'List expenses. Pass ?view=full for enriched view with GL data',
      parameters: [
        { name: 'view',     in: 'query', schema: { type: 'string', enum: ['full'] } },
        { name: 'from',     in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',       in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'category', in: 'query', schema: { type: 'string' } },
        { name: 'search',   in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of expenses' } },
    },
    post: {
      tags: ['Accounting'],
      summary: 'Create expense and post to GL',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['title', 'amount'],
              properties: {
                title:        { type: 'string' },
                category:     { type: 'string', example: 'office' },
                amount:       { type: 'number' },
                account_id:   { type: 'string', description: 'GL expense account override' },
                description:  { type: 'string' },
                expense_date: { type: 'string', format: 'date' },
                receipt:      { type: 'string', description: 'Receipt URL' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Expense created and GL entry posted' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/expenses/{id}': {
    put: {
      tags: ['Accounting'],
      summary: 'Update expense — voids old GL entry and reposts',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated expense with new GL entry' } },
    },
    delete: {
      tags: ['Accounting'],
      summary: 'Delete expense and void its GL entry',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },
};
