module.exports = {
  '/billing/status': {
    get: {
      tags: ['Billing'],
      summary: 'Get subscription status',
      responses: { 200: { description: 'Billing status object' } },
    },
  },

  '/billing/transactions': {
    get: {
      tags: ['Billing'],
      summary: 'List billing transactions',
      responses: { 200: { description: 'Array of transactions' } },
    },
  },

  '/billing/card': {
    get: {
      tags: ['Billing'],
      summary: 'Get saved card details',
      responses: { 200: { description: 'Card object' } },
    },
  },

  '/billing/subscribe': {
    post: {
      tags: ['Billing'],
      summary: 'Initiate subscription (business owner)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['plan'],
              properties: {
                plan: { type: 'string', enum: ['starter', 'pro', 'enterprise'] },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Paystack payment link' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/billing/verify': {
    post: {
      tags: ['Billing'],
      summary: 'Verify subscription payment (business owner)',
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
      responses: { 200: { description: 'Subscription activated' } },
    },
  },

  '/billing/authorize-card': {
    post: {
      tags: ['Billing'],
      summary: 'Authorize a card for auto-renewal (business owner)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { callback_url: { type: 'string' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Paystack authorization URL' } },
    },
  },

  '/billing/save-card': {
    post: {
      tags: ['Billing'],
      summary: 'Save card after authorization (business owner)',
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
      responses: { 200: { description: 'Card saved' } },
    },
  },

  '/billing/cancel': {
    post: {
      tags: ['Billing'],
      summary: 'Cancel subscription (business owner)',
      responses: { 200: { description: 'Subscription cancelled' } },
    },
  },

  '/billing/callback': {
    get: {
      tags: ['Billing'],
      summary: 'Paystack card redirect callback',
      parameters: [
        { name: 'reference', in: 'query', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Card saved' } },
    },
  },

  '/plan-prices': {
    get: {
      tags: ['Billing'],
      summary: 'Get public plan prices (no auth)',
      security: [],
      responses: { 200: { description: 'Plans object with prices and limits' } },
    },
  },

  '/billing/module-prices': {
    get: {
      tags: ['Billing'],
      summary: 'Get add-on module prices',
      responses: { 200: { description: 'Module prices array' } },
    },
  },
};
