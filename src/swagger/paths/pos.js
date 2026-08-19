module.exports = {
  // ── SALE ───────────────────────────────────────────────────────────────────
  '/pos/sale': {
    post: {
      tags: ['POS'],
      summary: 'Complete a cash / split / cheque sale',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      product_id:  { type: 'string' },
                      quantity:    { type: 'integer' },
                      unit_price:  { type: 'number' },
                      variant_key: { type: 'string' },
                    },
                  },
                },
                payment_method:  { type: 'string', enum: ['cash', 'split', 'cheque'], default: 'cash' },
                amount_tendered: { type: 'number' },
                customer_name:   { type: 'string' },
                customer_phone:  { type: 'string' },
                payment_ref:     { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Sale order with change amount' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  // ── REFUND ─────────────────────────────────────────────────────────────────
  '/pos/refund': {
    post: {
      tags: ['POS'],
      summary: 'Refund a POS sale (full or partial)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['order_number'],
              properties: {
                order_number: { type: 'string' },
                reason:       { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      product_id: { type: 'string' },
                      quantity:   { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Refund result with refunded items and new payment status' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  // ── PRODUCTS (POS catalogue) ───────────────────────────────────────────────
  '/pos/products': {
    get: {
      tags: ['POS'],
      summary: 'List active products for POS terminal',
      parameters: [
        { name: 'search',   in: 'query', schema: { type: 'string' } },
        { name: 'category', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of products with available stock' } },
    },
  },

  // ── PAYSTACK FLOW ──────────────────────────────────────────────────────────
  '/pos/paystack/init': {
    post: {
      tags: ['POS'],
      summary: 'Initialise Paystack payment (card / MoMo)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items'],
              properties: {
                items:          { type: 'array', items: { type: 'object' } },
                payment_method: { type: 'string', enum: ['card', 'momo', 'card_terminal'] },
                customer_name:  { type: 'string' },
                customer_phone: { type: 'string' },
                customer_email: { type: 'string', format: 'email' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Paystack authorization URL or pending reference' } },
    },
  },

  '/pos/paystack/verify': {
    post: {
      tags: ['POS'],
      summary: 'Verify Paystack payment and complete sale',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['reference'],
              properties: { reference: { type: 'string' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Completed sale order' } },
    },
  },

  '/pos/paystack/pending': {
    get: {
      tags: ['POS'],
      summary: 'Poll for pending Paystack orders (used by terminal)',
      responses: { 200: { description: 'Array of pending orders' } },
    },
  },

  '/pos/paystack/cancel': {
    post: {
      tags: ['POS'],
      summary: 'Cancel a pending Paystack payment',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['reference'],
              properties: { reference: { type: 'string' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Cancelled' } },
    },
  },

  '/pos/paystack/terminal': {
    get: {
      tags: ['POS'],
      summary: 'Get virtual terminal info (WhatsApp number, code)',
      responses: { 200: { description: 'Terminal info object' } },
    },
  },

  // ── CUSTOMER DISPLAY ───────────────────────────────────────────────────────
  '/pos/display/current': {
    get: {
      tags: ['POS'],
      summary: 'Get current customer display session',
      responses: { 200: { description: 'Display session object' } },
    },
  },

  '/pos/display/queue': {
    get: {
      tags: ['POS'],
      summary: 'Get display queue session',
      responses: { 200: { description: 'Queue session object' } },
    },
  },

  '/pos/display/show': {
    post: {
      tags: ['POS'],
      summary: 'Push order to customer display',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { order_id: { type: 'string' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Display updated' } },
    },
  },

  '/pos/display/clear': {
    post: {
      tags: ['POS'],
      summary: 'Clear customer display session',
      responses: { 200: { description: 'Display cleared' } },
    },
  },

  // ── SHIFTS ─────────────────────────────────────────────────────────────────
  '/pos/shifts/open': {
    post: {
      tags: ['POS'],
      summary: 'Open a new shift',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { opening_float: { type: 'number', example: 500 } },
            },
          },
        },
      },
      responses: { 201: { description: 'Shift opened' } },
    },
  },

  '/pos/shifts/current': {
    get: {
      tags: ['POS'],
      summary: 'Get current open shift',
      responses: { 200: { description: 'Shift object or null' } },
    },
  },

  '/pos/shifts/close': {
    post: {
      tags: ['POS'],
      summary: 'Close current shift',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { closing_float: { type: 'number' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Closed shift with summary' } },
    },
  },

  '/pos/shifts': {
    get: {
      tags: ['POS'],
      summary: 'List shift history',
      parameters: [
        { name: 'from',  in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',    in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'page',  in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
      ],
      responses: { 200: { description: 'Array of shifts' } },
    },
  },

  '/pos/shifts/{id}': {
    get: {
      tags: ['POS'],
      summary: 'Get shift detail',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Shift detail with sales breakdown' } },
    },
  },

  '/pos/shifts/{id}/z-report': {
    get: {
      tags: ['POS'],
      summary: 'Get Z-report for a shift',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Z-report object' } },
    },
  },
};
