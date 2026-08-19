module.exports = {
  '/contracts': {
    get: {
      tags: ['Projects'],
      summary: 'List contracts',
      responses: { 200: { description: 'Array of contracts' } },
    },
    post: {
      tags: ['Projects'],
      summary: 'Create contract',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['title'],
              properties: {
                title:         { type: 'string' },
                client_name:   { type: 'string' },
                value:         { type: 'number' },
                start_date:    { type: 'string', format: 'date' },
                end_date:      { type: 'string', format: 'date' },
                retention_pct: { type: 'number' },
                notes:         { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Contract created' } },
    },
  },

  '/contracts/{id}': {
    get: {
      tags: ['Projects'],
      summary: 'Get contract by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Contract object' }, 404: { $ref: '#/components/responses/NotFound' } },
    },
    put: {
      tags: ['Projects'],
      summary: 'Update contract',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated contract' } },
    },
    delete: {
      tags: ['Projects'],
      summary: 'Delete contract (business owner)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  '/contracts/{id}/projects/{projectId}': {
    post: {
      tags: ['Projects'],
      summary: 'Link project to contract',
      parameters: [
        { name: 'id',        in: 'path', required: true, schema: { type: 'string' } },
        { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Project linked' } },
    },
    delete: {
      tags: ['Projects'],
      summary: 'Unlink project from contract',
      parameters: [
        { name: 'id',        in: 'path', required: true, schema: { type: 'string' } },
        { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Project unlinked' } },
    },
  },

  '/contracts/{id}/documents': {
    post: {
      tags: ['Projects'],
      summary: 'Upload contract document',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
          },
        },
      },
      responses: { 200: { description: 'Document uploaded' } },
    },
  },

  '/contracts/{id}/documents/{docId}': {
    delete: {
      tags: ['Projects'],
      summary: 'Remove contract document',
      parameters: [
        { name: 'id',    in: 'path', required: true, schema: { type: 'string' } },
        { name: 'docId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Document removed' } },
    },
  },

  '/contracts/{id}/notes': {
    post: {
      tags: ['Projects'],
      summary: 'Add note to contract',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', required: ['body'], properties: { body: { type: 'string' } } },
          },
        },
      },
      responses: { 200: { description: 'Note added' } },
    },
  },

  '/contracts/{id}/notes/{noteId}': {
    delete: {
      tags: ['Projects'],
      summary: 'Remove contract note',
      parameters: [
        { name: 'id',     in: 'path', required: true, schema: { type: 'string' } },
        { name: 'noteId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Note removed' } },
    },
  },

  '/contracts/{id}/payment-schedule': {
    post: {
      tags: ['Projects'],
      summary: 'Add payment milestone to contract',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['description', 'amount'],
              properties: {
                description: { type: 'string' },
                amount:      { type: 'number' },
                due_date:    { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Payment milestone added' } },
    },
  },

  '/contracts/{id}/payment-schedule/{milestoneId}': {
    put: {
      tags: ['Projects'],
      summary: 'Update payment milestone',
      parameters: [
        { name: 'id',          in: 'path', required: true, schema: { type: 'string' } },
        { name: 'milestoneId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated milestone' } },
    },
    delete: {
      tags: ['Projects'],
      summary: 'Remove payment milestone',
      parameters: [
        { name: 'id',          in: 'path', required: true, schema: { type: 'string' } },
        { name: 'milestoneId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Milestone removed' } },
    },
  },

  '/contracts/{id}/signatories': {
    post: {
      tags: ['Projects'],
      summary: 'Add signatory to contract',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:  { type: 'string' },
                email: { type: 'string', format: 'email' },
                role:  { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Signatory added' } },
    },
  },

  '/contracts/{id}/signatories/{signatoryId}': {
    put: {
      tags: ['Projects'],
      summary: 'Update signatory',
      parameters: [
        { name: 'id',          in: 'path', required: true, schema: { type: 'string' } },
        { name: 'signatoryId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated signatory' } },
    },
    delete: {
      tags: ['Projects'],
      summary: 'Remove signatory',
      parameters: [
        { name: 'id',          in: 'path', required: true, schema: { type: 'string' } },
        { name: 'signatoryId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Signatory removed' } },
    },
  },
};
