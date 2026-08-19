module.exports = {
  // ── PAYSTACK SUBACCOUNT ────────────────────────────────────────────────────
  '/paystack/banks': {
    get: {
      tags: ['Misc'],
      summary: 'List supported banks for Paystack subaccount',
      responses: { 200: { description: 'Array of banks' } },
    },
  },

  '/paystack/subaccount': {
    get: {
      tags: ['Misc'],
      summary: 'Get Paystack subaccount details',
      responses: { 200: { description: 'Subaccount object' } },
    },
    post: {
      tags: ['Misc'],
      summary: 'Connect Paystack subaccount (business owner)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['bank_code', 'account_number', 'business_name'],
              properties: {
                bank_code:       { type: 'string' },
                account_number:  { type: 'string' },
                business_name:   { type: 'string' },
                percentage_charge: { type: 'number' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Subaccount connected' } },
    },
    delete: {
      tags: ['Misc'],
      summary: 'Disconnect Paystack subaccount (business owner)',
      responses: { 200: { description: 'Subaccount disconnected' } },
    },
  },

  // ── PAYOUT METHODS ─────────────────────────────────────────────────────────
  '/payout-methods': {
    get: {
      tags: ['Misc'],
      summary: 'List payout methods',
      responses: { 200: { description: 'Array of payout methods' } },
    },
    post: {
      tags: ['Misc'],
      summary: 'Create payout method',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['type'],
              properties: {
                type:           { type: 'string', enum: ['bank', 'momo'] },
                bank_name:      { type: 'string' },
                account_number: { type: 'string' },
                account_name:   { type: 'string' },
                momo_number:    { type: 'string' },
                network:        { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Payout method created' } },
    },
  },

  '/payout-methods/{id}/default': {
    patch: {
      tags: ['Misc'],
      summary: 'Set payout method as default',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Default updated' } },
    },
  },

  '/payout-methods/{id}': {
    delete: {
      tags: ['Misc'],
      summary: 'Delete payout method',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  // ── PAYOUTS ────────────────────────────────────────────────────────────────
  '/payouts/balance': {
    get: {
      tags: ['Misc'],
      summary: 'Get payout balance',
      responses: { 200: { description: 'Available and pending balance' } },
    },
  },

  '/payouts/settings': {
    get: {
      tags: ['Misc'],
      summary: 'Get payout settings',
      responses: { 200: { description: 'Payout settings object' } },
    },
    put: {
      tags: ['Misc'],
      summary: 'Update payout settings (business owner)',
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated settings' } },
    },
  },

  '/payouts': {
    get: {
      tags: ['Misc'],
      summary: 'List payout requests',
      responses: { 200: { description: 'Array of payouts' } },
    },
    post: {
      tags: ['Misc'],
      summary: 'Request a payout',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['amount'],
              properties: {
                amount:           { type: 'number' },
                payout_method_id: { type: 'string' },
                notes:            { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Payout request created' } },
    },
  },

  // ── JOBS ───────────────────────────────────────────────────────────────────
  '/jobs': {
    get: {
      tags: ['Misc'],
      summary: 'List jobs',
      responses: { 200: { description: 'Array of jobs' } },
    },
    post: {
      tags: ['Misc'],
      summary: 'Create job',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['title'],
              properties: {
                title:       { type: 'string' },
                customer_id: { type: 'string' },
                description: { type: 'string' },
                due_date:    { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Job created' } },
    },
  },

  '/jobs/{id}': {
    get: {
      tags: ['Misc'],
      summary: 'Get job by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Job object' } },
    },
    put: {
      tags: ['Misc'],
      summary: 'Update job',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated job' } },
    },
    delete: {
      tags: ['Misc'],
      summary: 'Delete job (business owner)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  '/jobs/{id}/invoice': {
    post: {
      tags: ['Misc'],
      summary: 'Generate invoice from job',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 201: { description: 'Invoice created from job' } },
    },
  },

  // ── LABOUR ─────────────────────────────────────────────────────────────────
  '/labour/board': {
    get: {
      tags: ['Misc'],
      summary: 'Get labour allocation board',
      responses: { 200: { description: 'Labour board with employee allocations' } },
    },
  },

  '/labour/by-project': {
    get: {
      tags: ['Misc'],
      summary: 'Get labour grouped by project',
      responses: { 200: { description: 'Labour allocations per project' } },
    },
  },

  '/labour/allocate': {
    post: {
      tags: ['Misc'],
      summary: 'Allocate labour to a project',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['project_id', 'employee_id'],
              properties: {
                project_id:  { type: 'string' },
                employee_id: { type: 'string' },
                role:        { type: 'string' },
                from:        { type: 'string', format: 'date' },
                to:          { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Labour allocated' } },
    },
  },

  // ── SERVICE REQUESTS ───────────────────────────────────────────────────────
  '/service-requests/types': {
    get: {
      tags: ['Misc'],
      summary: 'List service request type catalogue (authenticated)',
      responses: { 200: { description: 'Array of service types' } },
    },
  },

  '/service-requests': {
    get: {
      tags: ['Misc'],
      summary: 'List service requests (merchant)',
      responses: { 200: { description: 'Array of service requests' } },
    },
  },

  '/service-requests/{id}': {
    get: {
      tags: ['Misc'],
      summary: 'Get service request by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Service request object' } },
    },
  },

  '/service-requests/{id}/quote': {
    post: {
      tags: ['Misc'],
      summary: 'Send quote for a service request',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['amount'],
              properties: {
                amount:      { type: 'number' },
                description: { type: 'string' },
                valid_until: { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Quote sent to customer' } },
    },
  },

  '/service-requests/{id}/stage': {
    patch: {
      tags: ['Misc'],
      summary: 'Update service request stage',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['stage'],
              properties: {
                stage: { type: 'string', enum: ['new', 'quoted', 'accepted', 'in_progress', 'completed', 'cancelled'] },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Stage updated' } },
    },
  },

  '/service-requests/{tenantSlug}/services': {
    get: {
      tags: ['Misc'],
      summary: 'List public services for a tenant (no auth)',
      security: [],
      parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of public services' } },
    },
  },

  '/service-requests/{tenantSlug}': {
    post: {
      tags: ['Misc'],
      summary: 'Submit a public service request (no auth, supports file uploads)',
      security: [],
      parameters: [{ name: 'tenantSlug', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                name:    { type: 'string' },
                email:   { type: 'string', format: 'email' },
                phone:   { type: 'string' },
                message: { type: 'string' },
                files:   { type: 'array', items: { type: 'string', format: 'binary' } },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Service request submitted' } },
    },
  },

  // ── TRACKING (client portal) ───────────────────────────────────────────────
  '/track/{token}': {
    get: {
      tags: ['Misc'],
      summary: 'Resolve a tracking token — returns job, project or service request (no auth)',
      security: [],
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Tracked entity data' }, 404: { $ref: '#/components/responses/NotFound' } },
    },
  },

  '/track/{token}/quote-response': {
    post: {
      tags: ['Misc'],
      summary: 'Accept or reject a quote via tracking link (no auth)',
      security: [],
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['accepted'],
              properties: { accepted: { type: 'boolean' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Quote response recorded' } },
    },
  },

  '/track/{token}/pay': {
    post: {
      tags: ['Misc'],
      summary: 'Initiate payment via tracking link (no auth)',
      security: [],
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Paystack payment URL' } },
    },
  },

  '/track/{token}/confirm-payment': {
    post: {
      tags: ['Misc'],
      summary: 'Confirm payment via tracking link (no auth)',
      security: [],
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
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
      responses: { 200: { description: 'Payment confirmed' } },
    },
  },

  '/track/{token}/documents': {
    get: {
      tags: ['Misc'],
      summary: 'List shared documents via tracking link (no auth)',
      security: [],
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of documents' } },
    },
    post: {
      tags: ['Misc'],
      summary: 'Upload document via tracking link (no auth)',
      security: [],
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
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

  '/track/{token}/messages': {
    get: {
      tags: ['Misc'],
      summary: 'List messages via tracking link (no auth)',
      security: [],
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of messages' } },
    },
    post: {
      tags: ['Misc'],
      summary: 'Post message via tracking link (no auth)',
      security: [],
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', required: ['body'], properties: { body: { type: 'string' } } },
          },
        },
      },
      responses: { 201: { description: 'Message posted' } },
    },
  },

  // ── CHAT ───────────────────────────────────────────────────────────────────
  '/chat/conversation': {
    get: {
      tags: ['Misc'],
      summary: 'Get or create support conversation for current tenant',
      responses: { 200: { description: 'Conversation object' } },
    },
  },

  '/chat/messages/{conversationId}': {
    get: {
      tags: ['Misc'],
      summary: 'Get messages for a conversation',
      parameters: [{ name: 'conversationId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of messages' } },
    },
  },

  '/chat/messages': {
    post: {
      tags: ['Misc'],
      summary: 'Send a chat message',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['conversation_id', 'body'],
              properties: {
                conversation_id: { type: 'string' },
                body:            { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Message sent' } },
    },
  },

  '/chat/admin/conversations': {
    get: {
      tags: ['Misc'],
      summary: 'List all conversations (platform admin)',
      responses: { 200: { description: 'Array of conversations' } },
    },
  },

  '/chat/conversations/{id}/resolve': {
    patch: {
      tags: ['Misc'],
      summary: 'Resolve a conversation (platform admin)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Conversation resolved' } },
    },
  },

  // ── WEBHOOKS ───────────────────────────────────────────────────────────────
  '/webhooks/paystack': {
    post: {
      tags: ['Misc'],
      summary: 'Paystack webhook receiver — verifies HMAC signature and processes events',
      security: [],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Event acknowledged' } },
    },
  },
};
