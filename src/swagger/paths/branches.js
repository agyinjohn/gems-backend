module.exports = {
  '/branches': {
    get: {
      tags: ['Branches'],
      summary: 'List branches',
      responses: {
        200: { description: 'Array of branches' },
        401: { $ref: '#/components/responses/Unauthorized' },
      },
    },
    post: {
      tags: ['Branches'],
      summary: 'Create branch (business owner)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:    { type: 'string', example: 'Main Branch' },
                address: { type: 'string' },
                phone:   { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Branch created' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/branches/{id}': {
    put: {
      tags: ['Branches'],
      summary: 'Update branch (business owner)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: {
        200: { description: 'Updated branch' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    delete: {
      tags: ['Branches'],
      summary: 'Delete branch (business owner)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  '/branches/{id}/staff': {
    get: {
      tags: ['Branches'],
      summary: 'List staff assigned to a branch',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of users' } },
    },
  },
};
