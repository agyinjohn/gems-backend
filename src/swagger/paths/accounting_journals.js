module.exports = {
  // ── JOURNAL ENTRIES ────────────────────────────────────────────────────────
  '/journal-entries': {
    get: {
      tags: ['Accounting'],
      summary: 'List journal entries. Pass ?view=full for enriched view',
      parameters: [
        { name: 'view',   in: 'query', schema: { type: 'string', enum: ['full'] } },
        { name: 'from',   in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',     in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'source', in: 'query', schema: { type: 'string', example: 'manual' } },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['posted', 'voided'] } },
        { name: 'search', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of journal entries' } },
    },
    post: {
      tags: ['Accounting'],
      summary: 'Post a manual journal entry (must balance)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['description', 'lines'],
              properties: {
                description: { type: 'string' },
                entry_date:  { type: 'string', format: 'date' },
                lines: {
                  type: 'array',
                  minItems: 2,
                  items: {
                    type: 'object',
                    required: ['account_id'],
                    properties: {
                      account_id:  { type: 'string' },
                      debit:       { type: 'number', default: 0 },
                      credit:      { type: 'number', default: 0 },
                      description: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Journal entry posted' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/journal-entries/{id}': {
    get: {
      tags: ['Accounting'],
      summary: 'Get journal entry detail with account names',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Journal entry detail' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  '/journal-entries/{id}/void': {
    post: {
      tags: ['Accounting'],
      summary: 'Void a journal entry — posts a reversing entry',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { reason: { type: 'string' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Reversal entry posted' } },
    },
  },

  '/accounting/import': {
    post: {
      tags: ['Accounting'],
      summary: 'Bulk import expenses or journal entries from CSV/JSON rows',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['type', 'rows'],
              properties: {
                type: { type: 'string', enum: ['expenses', 'journal'] },
                rows: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Import result with count and any row errors' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  // ── INVOICES ───────────────────────────────────────────────────────────────
  '/invoices': {
    get: {
      tags: ['Accounting'],
      summary: 'List invoices. Pass ?view=full for enriched view',
      parameters: [
        { name: 'view',        in: 'query', schema: { type: 'string', enum: ['full'] } },
        { name: 'status',      in: 'query', schema: { type: 'string', example: 'sent,overdue' } },
        { name: 'customer_id', in: 'query', schema: { type: 'string' } },
        { name: 'from',        in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',          in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'search',      in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of invoices' } },
    },
    post: {
      tags: ['Accounting'],
      summary: 'Create invoice (draft)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['customer_name', 'due_date', 'lines'],
              properties: {
                customer_name:  { type: 'string' },
                customer_id:    { type: 'string' },
                customer_email: { type: 'string', format: 'email' },
                issue_date:     { type: 'string', format: 'date' },
                due_date:       { type: 'string', format: 'date' },
                notes:          { type: 'string' },
                order_id:       { type: 'string' },
                lines: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['description', 'quantity', 'unit_price'],
                    properties: {
                      description: { type: 'string' },
                      quantity:    { type: 'number' },
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
      responses: { 201: { description: 'Invoice created in draft status' } },
    },
  },

  '/invoices/{id}': {
    get: {
      tags: ['Accounting'],
      summary: 'Get invoice by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Invoice object with customer details' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  '/invoices/{id}/send': {
    patch: {
      tags: ['Accounting'],
      summary: 'Send invoice — moves draft → sent and posts AR GL entry',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Invoice sent, GL entry posted' },
        400: { description: 'Only draft invoices can be sent' },
      },
    },
  },

  '/invoices/{id}/payments': {
    post: {
      tags: ['Accounting'],
      summary: 'Record a payment against an invoice',
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
                method:    { type: 'string', enum: ['cash', 'bank_transfer', 'momo', 'cheque'], default: 'cash' },
                reference: { type: 'string' },
                note:      { type: 'string' },
                date:      { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Payment recorded, invoice status updated' } },
    },
  },

  '/invoices/{id}/void': {
    patch: {
      tags: ['Accounting'],
      summary: 'Void invoice and reverse GL entries',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Invoice voided' },
        400: { description: 'Cannot void a paid invoice — issue a credit note instead' },
      },
    },
  },

  // ── CREDIT NOTES ───────────────────────────────────────────────────────────
  '/credit-notes': {
    get: {
      tags: ['Accounting'],
      summary: 'List credit notes. Pass ?view=full for enriched view',
      parameters: [
        { name: 'view',   in: 'query', schema: { type: 'string', enum: ['full'] } },
        { name: 'status', in: 'query', schema: { type: 'string' } },
        { name: 'search', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of credit notes' } },
    },
    post: {
      tags: ['Accounting'],
      summary: 'Issue a credit note against a paid invoice',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['invoice_id', 'amount', 'reason'],
              properties: {
                invoice_id: { type: 'string' },
                amount:     { type: 'number' },
                reason:     { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Credit note issued, invoice amount_paid reduced, GL reversed' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },
};
