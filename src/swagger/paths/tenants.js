module.exports = {
  '/tenants/register': {
    post: {
      tags: ['Tenants'],
      summary: 'Register a new business (public)',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['business_name', 'email', 'password'],
              properties: {
                business_name: { type: 'string', example: 'GEMS Store' },
                email:         { type: 'string', format: 'email' },
                password:      { type: 'string' },
                phone:         { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Tenant created, JWT returned' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/my-tenant': {
    get: {
      tags: ['Tenants'],
      summary: "Get the caller's own tenant",
      responses: {
        200: { description: 'Tenant object' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },

  '/platform/tenants': {
    get: {
      tags: ['Tenants'],
      summary: 'List all tenants (platform admin)',
      responses: {
        200: { description: 'Array of tenants' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },

  '/platform/tenants/{id}': {
    get: {
      tags: ['Tenants'],
      summary: 'Get tenant by ID (platform admin)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Tenant object' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    patch: {
      tags: ['Tenants'],
      summary: 'Update tenant (platform admin)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated tenant' } },
    },
  },

  '/platform/tenants/{id}/suspend': {
    patch: {
      tags: ['Tenants'],
      summary: 'Suspend tenant (platform admin)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Tenant suspended' } },
    },
  },

  '/platform/tenants/{id}/activate': {
    patch: {
      tags: ['Tenants'],
      summary: 'Activate tenant (platform admin)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Tenant activated' } },
    },
  },
};
