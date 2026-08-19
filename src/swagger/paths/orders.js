module.exports = {
  '/orders': {
    get: {
      tags: ['Orders'],
      summary: 'List orders',
      parameters: [
        { name: 'status',         in: 'query', schema: { type: 'string' } },
        { name: 'payment_status', in: 'query', schema: { type: 'string' } },
        { name: 'source',         in: 'query', schema: { type: 'string', enum: ['internal', 'pos', 'storefront'] } },
        { name: 'from',           in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',             in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'page',           in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit',          in: 'query', schema: { type: 'integer', default: 50 } },
      ],
      responses: { 200: { description: 'Paginated orders array' } },
    },
    post: {
      tags: ['Orders'],
      summary: 'Create internal order',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['customer_name', 'items'],
              properties: {
                customer_name:  { type: 'string' },
                customer_email: { type: 'string', format: 'email' },
                customer_phone: { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      product_id:  { type: 'string' },
                      quantity:    { type: 'integer' },
                      unit_price:  { type: 'number' },
                      variant_key: { type: 'string' },
                    },
                  },
                },
                notes: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Order created' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/orders/{id}': {
    get: {
      tags: ['Orders'],
      summary: 'Get order by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Order object' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  '/orders/{id}/status': {
    patch: {
      tags: ['Orders'],
      summary: 'Update order status',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['status'],
              properties: {
                status: {
                  type: 'string',
                  enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
                },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated order' } },
    },
  },

  '/orders/{id}/pay': {
    patch: {
      tags: ['Orders'],
      summary: 'Mark internal order as paid',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                payment_method: { type: 'string', enum: ['cash', 'bank_transfer', 'momo', 'cheque'] },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Order marked as paid, stock deducted, GL posted' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  '/orders/{id}/invoice': {
    get: {
      tags: ['Orders'],
      summary: 'Get printable invoice for an order',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Order + business details for invoice rendering' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },
};
