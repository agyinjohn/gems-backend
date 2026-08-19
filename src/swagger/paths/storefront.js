module.exports = {
  // ── MARKETPLACE ────────────────────────────────────────────────────────────
  '/marketplace/shops': {
    get: {
      tags: ['Storefront'],
      summary: 'List all active public shops (no auth)',
      security: [],
      responses: { 200: { description: 'Array of shop summaries with sample images and categories' } },
    },
  },

  // ── PUBLIC STORE ───────────────────────────────────────────────────────────
  '/storefront/{tenantSlug}/branches': {
    get: {
      tags: ['Storefront'],
      summary: 'Get tenant branches for storefront (no auth)',
      security: [],
      parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Tenant info + branches array' } },
    },
  },

  '/storefront/products': {
    get: {
      tags: ['Storefront'],
      summary: 'List storefront products',
      security: [],
      parameters: [
        { name: 'tenant_slug', in: 'query', schema: { type: 'string' } },
        { name: 'category',    in: 'query', schema: { type: 'string' } },
        { name: 'search',      in: 'query', schema: { type: 'string' } },
        { name: 'branch_slug', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of products' } },
    },
  },

  '/storefront/{tenantSlug}/products/{productSlug}': {
    get: {
      tags: ['Storefront'],
      summary: 'Get single storefront product by slug (no auth)',
      security: [],
      parameters: [
        { name: 'tenantSlug',  in: 'path', required: true, schema: { type: 'string' } },
        { name: 'productSlug', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: { description: 'Product detail' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
  },

  '/storefront/{tenantSlug}/settings': {
    get: {
      tags: ['Storefront'],
      summary: 'Get public storefront settings (no auth)',
      security: [],
      parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Storefront settings' } },
    },
  },

  '/storefront/settings': {
    get: {
      tags: ['Storefront'],
      summary: 'Get merchant storefront settings (authenticated)',
      responses: { 200: { description: 'Merchant storefront settings' } },
    },
    put: {
      tags: ['Storefront'],
      summary: 'Update merchant storefront settings',
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated settings' } },
    },
  },

  '/storefront/resolve-domain': {
    get: {
      tags: ['Storefront'],
      summary: 'Resolve a custom domain to a tenant slug',
      security: [],
      parameters: [{ name: 'domain', in: 'query', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Tenant slug' } },
    },
  },

  '/storefront/categories': {
    get: {
      tags: ['Storefront'],
      summary: 'List storefront categories (no auth)',
      security: [],
      parameters: [{ name: 'tenant_slug', in: 'query', schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of categories' } },
    },
  },

  // ── CART ───────────────────────────────────────────────────────────────────
  '/storefront/cart/{cartId}': {
    get: {
      tags: ['Storefront'],
      summary: 'Get cart by ID (no auth)',
      security: [],
      parameters: [{ name: 'cartId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Cart object' } },
    },
    delete: {
      tags: ['Storefront'],
      summary: 'Clear cart (no auth)',
      security: [],
      parameters: [{ name: 'cartId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Empty cart' } },
    },
  },

  '/storefront/cart/add': {
    post: {
      tags: ['Storefront'],
      summary: 'Add item to cart (no auth)',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['product_id'],
              properties: {
                cart_id:     { type: 'string' },
                product_id:  { type: 'string' },
                quantity:    { type: 'integer', default: 1 },
                tenant_id:   { type: 'string' },
                variant_key: { type: 'string' },
                selections:  { type: 'object' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Updated cart' },
        409: { description: 'Out of stock or service item' },
      },
    },
  },

  '/storefront/cart/update': {
    patch: {
      tags: ['Storefront'],
      summary: 'Update cart item quantity (no auth)',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['cart_id', 'product_id', 'quantity'],
              properties: {
                cart_id:     { type: 'string' },
                product_id:  { type: 'string' },
                quantity:    { type: 'integer', description: 'Set to 0 to remove item' },
                variant_key: { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated cart' } },
    },
  },

  // ── CHECKOUT ───────────────────────────────────────────────────────────────
  '/storefront/checkout': {
    post: {
      tags: ['Storefront'],
      summary: 'Initiate checkout — creates order and returns Paystack URL',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['cart_id', 'customer_name', 'customer_email'],
              properties: {
                cart_id:        { type: 'string' },
                customer_name:  { type: 'string' },
                customer_email: { type: 'string', format: 'email' },
                customer_phone: { type: 'string' },
                coupon_code:    { type: 'string' },
                branch_id:      { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Paystack authorization URL + order reference' },
        400: { $ref: '#/components/responses/BadRequest' },
      },
    },
  },

  '/storefront/verify-payment': {
    post: {
      tags: ['Storefront'],
      summary: 'Verify storefront payment after Paystack redirect',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['reference'],
              properties: { reference: { type: 'string' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Order confirmed' } },
    },
  },

  '/storefront/orders/{orderNumber}': {
    get: {
      tags: ['Storefront'],
      summary: 'Track order by order number (no auth)',
      security: [],
      parameters: [{ name: 'orderNumber', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Order tracking info' } },
    },
  },

  '/storefront/{tenantSlug}/orders/{reference}': {
    get: {
      tags: ['Storefront'],
      summary: 'Track order by tenant slug + reference (no auth)',
      security: [],
      parameters: [
        { name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'reference',  in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Order tracking info' } },
    },
  },

  // ── CUSTOMER AUTH ──────────────────────────────────────────────────────────
  '/storefront/{tenantSlug}/customers/register': {
    post: {
      tags: ['Storefront'],
      summary: 'Register a store customer account',
      security: [],
      parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'email', 'password'],
              properties: {
                name:     { type: 'string' },
                email:    { type: 'string', format: 'email' },
                password: { type: 'string' },
                phone:    { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Customer created + JWT' } },
    },
  },

  '/storefront/{tenantSlug}/customers/login': {
    post: {
      tags: ['Storefront'],
      summary: 'Login as store customer',
      security: [],
      parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password'],
              properties: {
                email:    { type: 'string', format: 'email' },
                password: { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'JWT + customer object' } },
    },
  },

  '/storefront/{tenantSlug}/customers/google': {
    post: {
      tags: ['Storefront'],
      summary: 'Google OAuth login for store customer',
      security: [],
      parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['id_token'],
              properties: { id_token: { type: 'string' } },
            },
          },
        },
      },
      responses: { 200: { description: 'JWT + customer object' } },
    },
  },

  '/storefront/customer/me': {
    get: {
      tags: ['Storefront'],
      summary: 'Get logged-in store customer profile',
      responses: { 200: { description: 'Customer object' } },
    },
  },

  '/storefront/customer/orders': {
    get: {
      tags: ['Storefront'],
      summary: 'Get orders for logged-in store customer',
      responses: { 200: { description: 'Array of orders' } },
    },
  },

  '/storefront/customer/reviews': {
    get: {
      tags: ['Storefront'],
      summary: 'Get reviews left by logged-in store customer',
      responses: { 200: { description: 'Array of reviews' } },
    },
  },

  '/storefront/customer/reviews/{id}': {
    patch: {
      tags: ['Storefront'],
      summary: 'Update own review',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated review' } },
    },
  },

  // ── PRODUCT REVIEWS (public) ───────────────────────────────────────────────
  '/storefront/{tenantSlug}/products/{productSlug}/reviews': {
    get: {
      tags: ['Storefront'],
      summary: 'List reviews for a product (no auth)',
      security: [],
      parameters: [
        { name: 'tenantSlug',  in: 'path', required: true, schema: { type: 'string' } },
        { name: 'productSlug', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of reviews' } },
    },
    post: {
      tags: ['Storefront'],
      summary: 'Submit a product review (customer token or guest)',
      security: [],
      parameters: [
        { name: 'tenantSlug',  in: 'path', required: true, schema: { type: 'string' } },
        { name: 'productSlug', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['rating'],
              properties: {
                rating:     { type: 'integer', minimum: 1, maximum: 5 },
                comment:    { type: 'string' },
                order_ref:  { type: 'string', description: 'Required for guest reviews' },
                guest_email:{ type: 'string', format: 'email' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Review submitted' } },
    },
  },

  '/storefront/{tenantSlug}/products/{productSlug}/reviews/eligibility': {
    get: {
      tags: ['Storefront'],
      summary: 'Check if caller is eligible to review a product',
      security: [],
      parameters: [
        { name: 'tenantSlug',  in: 'path', required: true, schema: { type: 'string' } },
        { name: 'productSlug', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Eligibility result' } },
    },
  },

  // ── COUPONS ────────────────────────────────────────────────────────────────
  '/storefront/coupons/validate': {
    post: {
      tags: ['Storefront'],
      summary: 'Validate a coupon code (no auth)',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['code'],
              properties: {
                code:        { type: 'string' },
                subtotal:    { type: 'number' },
                tenant_id:   { type: 'string' },
                tenant_slug: { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Coupon valid — discount details returned' },
        400: { description: 'Invalid or expired coupon' },
      },
    },
  },

  '/coupons': {
    get: {
      tags: ['Storefront'],
      summary: 'List coupons (merchant)',
      responses: { 200: { description: 'Array of coupons' } },
    },
    post: {
      tags: ['Storefront'],
      summary: 'Create coupon (business owner)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['code', 'discount_value'],
              properties: {
                code:               { type: 'string', example: 'SAVE10' },
                discount_type:      { type: 'string', enum: ['percent', 'fixed'], default: 'percent' },
                discount_value:     { type: 'number' },
                min_order_amount:   { type: 'number' },
                max_uses:           { type: 'integer' },
                expires_at:         { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Coupon created' } },
    },
  },

  '/coupons/{id}': {
    delete: {
      tags: ['Storefront'],
      summary: 'Delete coupon (business owner)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  // ── PROMOTIONS ─────────────────────────────────────────────────────────────
  '/promotions': {
    get: {
      tags: ['Storefront'],
      summary: 'List promotions (merchant)',
      responses: { 200: { description: 'Array of promotions' } },
    },
    post: {
      tags: ['Storefront'],
      summary: 'Create promotion (business owner)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'discount_value'],
              properties: {
                name:           { type: 'string' },
                discount_type:  { type: 'string', enum: ['percent', 'fixed'], default: 'percent' },
                discount_value: { type: 'number' },
                applies_to:     { type: 'string', enum: ['all', 'category', 'product'], default: 'all' },
                category_ids:   { type: 'array', items: { type: 'string' } },
                product_ids:    { type: 'array', items: { type: 'string' } },
                starts_at:      { type: 'string', format: 'date-time' },
                ends_at:        { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Promotion created' } },
    },
  },

  '/promotions/{id}': {
    patch: {
      tags: ['Storefront'],
      summary: 'Update promotion (business owner)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                is_active: { type: 'boolean' },
                ends_at:   { type: 'string', format: 'date-time' },
                name:      { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated promotion' } },
    },
    delete: {
      tags: ['Storefront'],
      summary: 'Delete promotion (business owner)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  // ── UPLOADS ────────────────────────────────────────────────────────────────
  '/uploads/storefront-image': {
    post: {
      tags: ['Storefront'],
      summary: 'Upload storefront hero image',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { image: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Image URL' } },
    },
  },

  '/uploads/logo': {
    post: {
      tags: ['Storefront'],
      summary: 'Upload business logo',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { image: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Logo URL' } },
    },
  },
};
