module.exports = {
  '/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Login',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password'],
              properties: {
                email:    { type: 'string', format: 'email', example: 'owner@gems-store.com' },
                password: { type: 'string', example: 'Admin@1234' },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'JWT token + user object',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  token:   { type: 'string' },
                  user:    { type: 'object' },
                },
              },
            },
          },
        },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },

  '/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'Get current user',
      responses: {
        200: { description: 'Current user object' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },

  '/auth/change-password': {
    post: {
      tags: ['Auth'],
      summary: 'Change password',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['current_password', 'new_password'],
              properties: {
                current_password: { type: 'string' },
                new_password:     { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Password changed' },
        400: { $ref: '#/components/responses/BadRequest' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },

  '/auth/forgot-password': {
    post: {
      tags: ['Auth'],
      summary: 'Request password reset email',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email'],
              properties: { email: { type: 'string', format: 'email' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Reset email sent' } },
    },
  },

  '/auth/reset-password': {
    post: {
      tags: ['Auth'],
      summary: 'Reset password with token',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token', 'new_password'],
              properties: {
                token:        { type: 'string' },
                new_password: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Password reset successful' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },
};
