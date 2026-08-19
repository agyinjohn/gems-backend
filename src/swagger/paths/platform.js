module.exports = {
  '/product-info': {
    get: {
      tags: ['Platform'],
      summary: 'Get product mode metadata (public)',
      security: [],
      responses: { 200: { description: 'Product mode info' } },
    },
  },

  '/platform/settings': {
    get: {
      tags: ['Platform'],
      summary: 'Get platform settings (platform admin)',
      responses: { 200: { description: 'Platform settings object' } },
    },
    put: {
      tags: ['Platform'],
      summary: 'Update platform settings (platform admin)',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                trial_days:                    { type: 'integer', example: 14 },
                grace_days:                    { type: 'integer', example: 7 },
                currency:                      { type: 'string', example: 'GHS' },
                platform_name:                 { type: 'string' },
                support_email:                 { type: 'string', format: 'email' },
                paystack_public_key:           { type: 'string' },
                paystack_secret_key:           { type: 'string' },
                paystack_webhook_url:          { type: 'string' },
                sms_sender_id:                 { type: 'string' },
                mnotify_api_key:               { type: 'string' },
                marketplace_commission_pct:    { type: 'number' },
                plans:                         { type: 'object' },
                feature_flags:                 { type: 'object' },
                sms_bundles: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label:   { type: 'string' },
                      credits: { type: 'integer' },
                      price:   { type: 'number' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated settings' } },
    },
  },

  '/platform/sms/balance': {
    get: {
      tags: ['Platform'],
      summary: 'Get mNotify provider SMS balance (platform admin)',
      responses: { 200: { description: 'Provider balance' } },
    },
  },

  '/audit-logs': {
    get: {
      tags: ['Misc'],
      summary: 'List audit logs',
      parameters: [
        { name: 'module',    in: 'query', schema: { type: 'string' } },
        { name: 'action',    in: 'query', schema: { type: 'string' } },
        { name: 'user_id',   in: 'query', schema: { type: 'string' } },
        { name: 'branch_id', in: 'query', schema: { type: 'string' } },
        { name: 'from',      in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',        in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'page',      in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit',     in: 'query', schema: { type: 'integer', default: 50 } },
      ],
      responses: { 200: { description: 'Paginated audit log entries' } },
    },
  },
};
