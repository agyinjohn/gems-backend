module.exports = {
  '/email/settings': {
    get: {
      tags: ['Email'],
      summary: 'Get email settings (business owner)',
      responses: { 200: { description: 'Email settings object' } },
    },
    put: {
      tags: ['Email'],
      summary: 'Update email settings (business owner)',
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated settings' } },
    },
  },

  '/email/verify': {
    post: {
      tags: ['Email'],
      summary: 'Send verification email to confirm SMTP settings',
      responses: { 200: { description: 'Verification email sent' } },
    },
  },

  '/email/templates': {
    get: {
      tags: ['Email'],
      summary: 'List email templates',
      responses: { 200: { description: 'Array of templates' } },
    },
  },

  '/email/templates/{key}': {
    put: {
      tags: ['Email'],
      summary: 'Update email template (business owner)',
      parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                subject: { type: 'string' },
                body:    { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated template' } },
    },
  },

  '/email/templates/{key}/reset': {
    post: {
      tags: ['Email'],
      summary: 'Reset email template to default (business owner)',
      parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Template reset' } },
    },
  },

  '/email/preview': {
    post: {
      tags: ['Email'],
      summary: 'Preview rendered email template',
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
      responses: { 200: { description: 'Rendered subject and HTML body' } },
    },
  },

  '/email/messages': {
    get: {
      tags: ['Email'],
      summary: 'List sent email messages',
      responses: { 200: { description: 'Array of email messages' } },
    },
  },

  '/email/send': {
    post: {
      tags: ['Email'],
      summary: 'Send a test email (business owner)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['to', 'subject', 'body'],
              properties: {
                to:      { type: 'string', format: 'email' },
                subject: { type: 'string' },
                body:    { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Email sent' } },
    },
  },
};
