module.exports = {
  // ── LOCATIONS ──────────────────────────────────────────────────────────────
  '/locations': {
    get: {
      tags: ['Assets'],
      summary: 'List storage locations',
      responses: { 200: { description: 'Array of locations' } },
    },
    post: {
      tags: ['Assets'],
      summary: 'Create location',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:        { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Location created' } },
    },
  },

  '/locations/{id}': {
    put: {
      tags: ['Assets'],
      summary: 'Update location',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated location' } },
    },
    delete: {
      tags: ['Assets'],
      summary: 'Delete location',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  // ── ASSET CATEGORIES ───────────────────────────────────────────────────────
  '/asset-categories': {
    get: {
      tags: ['Assets'],
      summary: 'List asset categories',
      responses: { 200: { description: 'Array of asset categories' } },
    },
    post: {
      tags: ['Assets'],
      summary: 'Create asset category',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: { name: { type: 'string' }, description: { type: 'string' } },
            },
          },
        },
      },
      responses: { 201: { description: 'Asset category created' } },
    },
  },

  '/asset-categories/{id}': {
    put: {
      tags: ['Assets'],
      summary: 'Update asset category',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated' } },
    },
    delete: {
      tags: ['Assets'],
      summary: 'Delete asset category',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  // ── ASSETS ─────────────────────────────────────────────────────────────────
  '/assets': {
    get: {
      tags: ['Assets'],
      summary: 'List assets',
      parameters: [
        { name: 'category_id', in: 'query', schema: { type: 'string' } },
        { name: 'location_id', in: 'query', schema: { type: 'string' } },
        { name: 'status',      in: 'query', schema: { type: 'string', enum: ['active', 'disposed', 'under_maintenance'] } },
      ],
      responses: { 200: { description: 'Array of assets' } },
    },
    post: {
      tags: ['Assets'],
      summary: 'Create asset',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'purchase_value'],
              properties: {
                name:           { type: 'string' },
                asset_code:     { type: 'string' },
                category_id:    { type: 'string' },
                location_id:    { type: 'string' },
                purchase_value: { type: 'number' },
                purchase_date:  { type: 'string', format: 'date' },
                status:         { type: 'string', enum: ['active', 'disposed', 'under_maintenance'] },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Asset created' } },
    },
  },

  '/assets/{id}': {
    get: {
      tags: ['Assets'],
      summary: 'Get asset by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Asset object' }, 404: { $ref: '#/components/responses/NotFound' } },
    },
    put: {
      tags: ['Assets'],
      summary: 'Update asset',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated asset' } },
    },
  },

  '/assets/{id}/log': {
    post: {
      tags: ['Assets'],
      summary: 'Add maintenance / movement log entry to asset',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['type', 'notes'],
              properties: {
                type:  { type: 'string', enum: ['maintenance', 'movement', 'disposal', 'other'] },
                notes: { type: 'string' },
                date:  { type: 'string', format: 'date' },
                cost:  { type: 'number' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Log entry added' } },
    },
  },
};
