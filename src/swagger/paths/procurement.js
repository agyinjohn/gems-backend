module.exports = {
  // ── SUPPLIERS ──────────────────────────────────────────────────────────────
  '/suppliers': {
    get: {
      tags: ['Procurement'],
      summary: 'List suppliers',
      responses: { 200: { description: 'Array of suppliers' } },
    },
    post: {
      tags: ['Procurement'],
      summary: 'Create supplier',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:    { type: 'string' },
                email:   { type: 'string', format: 'email' },
                phone:   { type: 'string' },
                address: { type: 'string' },
                notes:   { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Supplier created' } },
    },
  },

  '/suppliers/{id}': {
    put: {
      tags: ['Procurement'],
      summary: 'Update supplier',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated supplier' } },
    },
    delete: {
      tags: ['Procurement'],
      summary: 'Deactivate supplier',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Supplier deactivated' } },
    },
  },

  // ── PURCHASE ORDERS ────────────────────────────────────────────────────────
  '/purchase-orders': {
    get: {
      tags: ['Procurement'],
      summary: 'List purchase orders',
      parameters: [
        { name: 'status',      in: 'query', schema: { type: 'string' } },
        { name: 'supplier_id', in: 'query', schema: { type: 'string' } },
        { name: 'from',        in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'to',          in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: { 200: { description: 'Array of purchase orders' } },
    },
    post: {
      tags: ['Procurement'],
      summary: 'Create purchase order',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['supplier_id', 'items'],
              properties: {
                supplier_id:    { type: 'string' },
                expected_date:  { type: 'string', format: 'date' },
                notes:          { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      product_id:  { type: 'string' },
                      quantity:    { type: 'integer' },
                      unit_price:  { type: 'number' },
                      description: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Purchase order created' } },
    },
  },

  '/purchase-orders/{id}': {
    get: {
      tags: ['Procurement'],
      summary: 'Get purchase order by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Purchase order object' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    put: {
      tags: ['Procurement'],
      summary: 'Update purchase order (draft only)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated purchase order' } },
    },
  },

  '/purchase-orders/{id}/submit': {
    patch: {
      tags: ['Procurement'],
      summary: 'Submit PO for approval',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'PO submitted' } },
    },
  },

  '/purchase-orders/{id}/approve': {
    patch: {
      tags: ['Procurement'],
      summary: 'Approve PO (business owner / accountant)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'PO approved' } },
    },
  },

  '/purchase-orders/{id}/send': {
    patch: {
      tags: ['Procurement'],
      summary: 'Mark PO as sent to supplier',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'PO sent' } },
    },
  },

  '/purchase-orders/{id}/cancel': {
    patch: {
      tags: ['Procurement'],
      summary: 'Cancel PO',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'PO cancelled' } },
    },
  },

  '/purchase-orders/{id}/pay': {
    patch: {
      tags: ['Procurement'],
      summary: 'Mark PO as paid (business owner / accountant / procurement officer)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                payment_method: { type: 'string', enum: ['cash', 'bank_transfer', 'momo', 'cheque'] },
                reference:      { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'PO marked as paid, GL posted' } },
    },
  },

  '/purchase-orders/{id}/receive': {
    post: {
      tags: ['Procurement'],
      summary: 'Receive goods against a PO — updates stock',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      product_id:       { type: 'string' },
                      quantity_received: { type: 'integer' },
                    },
                  },
                },
                notes: { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Goods received, stock updated' } },
    },
  },
};
