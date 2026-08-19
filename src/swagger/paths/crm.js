module.exports = {
  // ── CUSTOMERS ──────────────────────────────────────────────────────────────
  '/customers': {
    get: {
      tags: ['CRM'],
      summary: 'List customers',
      responses: { 200: { description: 'Array of customers' } },
    },
    post: {
      tags: ['CRM'],
      summary: 'Create customer',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:    { type: 'string' },
                email:   { type: 'string', format: 'email' },
                phone:   { type: 'string' },
                company: { type: 'string' },
                address: { type: 'string' },
                segment: { type: 'string', enum: ['general', 'vip', 'wholesale'], default: 'general' },
                notes:   { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Customer created' } },
    },
  },

  // ── LEADS ──────────────────────────────────────────────────────────────────
  '/leads': {
    get: {
      tags: ['CRM'],
      summary: 'List leads',
      responses: { 200: { description: 'Array of leads with customer and assignee names' } },
    },
    post: {
      tags: ['CRM'],
      summary: 'Create lead',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['title'],
              properties: {
                title:        { type: 'string' },
                customer_id:  { type: 'string' },
                stage:        { type: 'string', enum: ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'], default: 'new' },
                value:        { type: 'number' },
                assigned_to:  { type: 'string' },
                notes:        { type: 'string' },
                next_followup:{ type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Lead created' } },
    },
  },

  '/leads/{id}': {
    patch: {
      tags: ['CRM'],
      summary: 'Update lead stage / value / notes',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                stage:         { type: 'string' },
                value:         { type: 'number' },
                notes:         { type: 'string' },
                next_followup: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated lead' } },
    },
  },

  // ── CONTACT HISTORY ────────────────────────────────────────────────────────
  '/contact-history': {
    get: {
      tags: ['CRM'],
      summary: 'List contact history',
      responses: { 200: { description: 'Array of contact history entries' } },
    },
    post: {
      tags: ['CRM'],
      summary: 'Log a customer contact',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                customer_id:  { type: 'string' },
                type:         { type: 'string', enum: ['call', 'email', 'meeting', 'sms', 'other'], default: 'call' },
                notes:        { type: 'string' },
                contact_date: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Contact history entry created' } },
    },
  },

  // ── MERCHANT REVIEWS ───────────────────────────────────────────────────────
  '/reviews': {
    get: {
      tags: ['CRM'],
      summary: 'List product reviews received by the merchant',
      responses: { 200: { description: 'Array of reviews' } },
    },
  },

  '/reviews/{id}': {
    patch: {
      tags: ['CRM'],
      summary: 'Hide / unhide or respond to a review (merchant)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                is_hidden:       { type: 'boolean' },
                merchant_reply:  { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated review' } },
    },
  },
};
