module.exports = {
  // ── USERS ──────────────────────────────────────────────────────────────────
  '/users': {
    get: {
      tags: ['Users'],
      summary: 'List users (business owner)',
      responses: { 200: { description: 'Array of users' } },
    },
    post: {
      tags: ['Users'],
      summary: 'Create user (business owner)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'email', 'password', 'role'],
              properties: {
                name:     { type: 'string' },
                email:    { type: 'string', format: 'email' },
                password: { type: 'string' },
                role:     {
                  type: 'string',
                  enum: ['business_owner', 'branch_manager', 'sales_staff', 'warehouse_staff', 'accountant', 'hr_manager', 'procurement_officer'],
                },
                branch_id:       { type: 'string' },
                custom_role_id:  { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'User created' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/users/{id}': {
    get: {
      tags: ['Users'],
      summary: 'Get user by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'User object' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    put: {
      tags: ['Users'],
      summary: 'Update user',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated user' } },
    },
    delete: {
      tags: ['Users'],
      summary: 'Delete user',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  // ── ROLES ──────────────────────────────────────────────────────────────────
  '/roles': {
    get: {
      tags: ['Roles'],
      summary: 'List custom roles',
      responses: { 200: { description: 'Array of roles' } },
    },
    post: {
      tags: ['Roles'],
      summary: 'Create custom role',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:        { type: 'string' },
                permissions: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Role created' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/roles/{id}': {
    put: {
      tags: ['Roles'],
      summary: 'Update custom role',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated role' } },
    },
    delete: {
      tags: ['Roles'],
      summary: 'Delete custom role',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },
};
