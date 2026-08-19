module.exports = {
  // ── CATEGORIES ─────────────────────────────────────────────────────────────
  '/categories': {
    get: {
      tags: ['Inventory'],
      summary: 'List categories (public when tenant_slug provided)',
      security: [],
      parameters: [
        { name: 'tenant_slug', in: 'query', schema: { type: 'string' }, description: 'Pass to fetch without auth' },
      ],
      responses: { 200: { description: 'Array of categories' } },
    },
    post: {
      tags: ['Inventory'],
      summary: 'Create category',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:          { type: 'string' },
                description:   { type: 'string' },
                scope:         { type: 'string', enum: ['product', 'service'], default: 'product' },
                custom_fields: { type: 'array', items: { type: 'object' } },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Category created' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/categories/{id}': {
    put: {
      tags: ['Inventory'],
      summary: 'Update category',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: {
        200: { description: 'Updated category' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    delete: {
      tags: ['Inventory'],
      summary: 'Delete category',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  // ── PRODUCTS ───────────────────────────────────────────────────────────────
  '/products': {
    get: {
      tags: ['Inventory'],
      summary: 'List products',
      parameters: [
        { name: 'search',      in: 'query', schema: { type: 'string' } },
        { name: 'category_id', in: 'query', schema: { type: 'string' } },
        { name: 'branch_id',   in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of products' } },
    },
    post: {
      tags: ['Inventory'],
      summary: 'Create product',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:                { type: 'string' },
                sku:                 { type: 'string' },
                barcode:             { type: 'string' },
                category_id:         { type: 'string' },
                price:               { type: 'number' },
                cost_price:          { type: 'number' },
                stock_qty:           { type: 'integer' },
                low_stock_threshold: { type: 'integer' },
                item_type:           { type: 'string', enum: ['product', 'service', 'bundle'] },
                sell_online:         { type: 'boolean' },
                images:              { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Product created' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/products/{id}': {
    get: {
      tags: ['Inventory'],
      summary: 'Get product by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Product object' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    put: {
      tags: ['Inventory'],
      summary: 'Update product',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated product' } },
    },
    delete: {
      tags: ['Inventory'],
      summary: 'Delete product (business owner)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  '/products/{id}/adjust-stock': {
    post: {
      tags: ['Inventory'],
      summary: 'Adjust stock quantity',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['quantity', 'type'],
              properties: {
                quantity: { type: 'integer' },
                type:     { type: 'string', enum: ['add', 'remove', 'set'] },
                notes:    { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Stock adjusted' } },
    },
  },

  '/products/{id}/movements': {
    get: {
      tags: ['Inventory'],
      summary: 'Get stock movement history for a product',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of stock movements' } },
    },
  },

  '/uploads/product-images': {
    post: {
      tags: ['Inventory'],
      summary: 'Upload product images (max 8)',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                images: { type: 'array', items: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Array of uploaded image URLs' } },
    },
  },
};
