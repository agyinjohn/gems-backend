module.exports = {
  '/sms/balance': {
    get: {
      tags: ['SMS'],
      summary: 'Get tenant SMS credit balance',
      responses: { 200: { description: 'Credit balance' } },
    },
  },

  '/sms/settings': {
    put: {
      tags: ['SMS'],
      summary: 'Update SMS settings (business owner)',
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated settings' } },
    },
  },

  '/sms/purchase': {
    post: {
      tags: ['SMS'],
      summary: 'Initiate SMS credit purchase (business owner)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['bundle_label'],
              properties: { bundle_label: { type: 'string' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Paystack payment URL' } },
    },
  },

  '/sms/purchase/verify': {
    post: {
      tags: ['SMS'],
      summary: 'Verify SMS credit purchase payment',
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
      responses: { 200: { description: 'Credits added to balance' } },
    },
  },

  '/sms/purchases': {
    get: {
      tags: ['SMS'],
      summary: 'List SMS credit purchase history',
      responses: { 200: { description: 'Array of purchases' } },
    },
  },

  '/sms/templates': {
    get: {
      tags: ['SMS'],
      summary: 'List SMS templates',
      responses: { 200: { description: 'Array of templates' } },
    },
  },

  '/sms/templates/{key}': {
    put: {
      tags: ['SMS'],
      summary: 'Update SMS template (business owner)',
      parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { body: { type: 'string' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated template' } },
    },
  },

  '/sms/templates/{key}/reset': {
    post: {
      tags: ['SMS'],
      summary: 'Reset SMS template to default (business owner)',
      parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Template reset' } },
    },
  },

  '/sms/preview': {
    post: {
      tags: ['SMS'],
      summary: 'Preview rendered SMS template with sample variables',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['key'],
              properties: {
                key:  { type: 'string' },
                vars: { type: 'object' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Rendered SMS body' } },
    },
  },

  '/sms/messages': {
    get: {
      tags: ['SMS'],
      summary: 'List sent SMS messages',
      responses: { 200: { description: 'Array of SMS messages' } },
    },
  },

  '/sms/send': {
    post: {
      tags: ['SMS'],
      summary: 'Send a test SMS (business owner)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['to', 'message'],
              properties: {
                to:      { type: 'string', example: '0241234567' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'SMS sent' } },
    },
  },
};
