module.exports = {
  '/projects/types': {
    get: {
      tags: ['Projects'],
      summary: 'List project types',
      responses: { 200: { description: 'Array of project types' } },
    },
  },

  '/projects': {
    get: {
      tags: ['Projects'],
      summary: 'List projects',
      parameters: [
        { name: 'status',      in: 'query', schema: { type: 'string' } },
        { name: 'branch_id',   in: 'query', schema: { type: 'string' } },
        { name: 'customer_id', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of projects' } },
    },
    post: {
      tags: ['Projects'],
      summary: 'Create project',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:          { type: 'string' },
                type:          { type: 'string' },
                customer_name: { type: 'string' },
                customer_id:   { type: 'string' },
                start_date:    { type: 'string', format: 'date' },
                end_date:      { type: 'string', format: 'date' },
                budget:        { type: 'number' },
                description:   { type: 'string' },
                contract_id:   { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Project created' } },
    },
  },

  '/projects/{id}': {
    get: {
      tags: ['Projects'],
      summary: 'Get project by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Project object' }, 404: { $ref: '#/components/responses/NotFound' } },
    },
    put: {
      tags: ['Projects'],
      summary: 'Update project',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated project' } },
    },
    delete: {
      tags: ['Projects'],
      summary: 'Delete project (business owner)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  '/projects/{id}/financials': {
    get: {
      tags: ['Projects'],
      summary: 'Get project financial summary',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Budget vs actual, cost breakdown' } },
    },
  },

  // ── MILESTONES ─────────────────────────────────────────────────────────────
  '/projects/{id}/milestones': {
    post: {
      tags: ['Projects'],
      summary: 'Add milestone to project',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:       { type: 'string' },
                due_date:   { type: 'string', format: 'date' },
                weight_pct: { type: 'number' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Project with updated milestones' } },
    },
  },

  '/projects/{id}/milestones/{milestoneId}': {
    put: {
      tags: ['Projects'],
      summary: 'Update milestone',
      parameters: [
        { name: 'id',          in: 'path', required: true, schema: { type: 'string' } },
        { name: 'milestoneId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated project' } },
    },
    delete: {
      tags: ['Projects'],
      summary: 'Remove milestone',
      parameters: [
        { name: 'id',          in: 'path', required: true, schema: { type: 'string' } },
        { name: 'milestoneId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Milestone removed' } },
    },
  },

  // ── TASKS ──────────────────────────────────────────────────────────────────
  '/projects/{id}/tasks': {
    post: {
      tags: ['Projects'],
      summary: 'Add task to project',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:        { type: 'string' },
                assigned_to: { type: 'string' },
                due_date:    { type: 'string', format: 'date' },
                status:      { type: 'string', enum: ['todo', 'in_progress', 'done'] },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Project with updated tasks' } },
    },
  },

  '/projects/{id}/tasks/{taskId}': {
    put: {
      tags: ['Projects'],
      summary: 'Update task',
      parameters: [
        { name: 'id',     in: 'path', required: true, schema: { type: 'string' } },
        { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated project' } },
    },
    delete: {
      tags: ['Projects'],
      summary: 'Remove task',
      parameters: [
        { name: 'id',     in: 'path', required: true, schema: { type: 'string' } },
        { name: 'taskId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Task removed' } },
    },
  },

  // ── VARIATIONS ─────────────────────────────────────────────────────────────
  '/projects/{id}/variations': {
    post: {
      tags: ['Projects'],
      summary: 'Add variation order',
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
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Variation added' } },
    },
  },

  '/projects/{id}/variations/{variationId}': {
    patch: {
      tags: ['Projects'],
      summary: 'Approve or reject variation (business owner)',
      parameters: [
        { name: 'id',          in: 'path', required: true, schema: { type: 'string' } },
        { name: 'variationId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['decision'],
              properties: {
                decision: { type: 'string', enum: ['approved', 'rejected'] },
                notes:    { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Variation decision recorded' } },
    },
    delete: {
      tags: ['Projects'],
      summary: 'Remove variation',
      parameters: [
        { name: 'id',          in: 'path', required: true, schema: { type: 'string' } },
        { name: 'variationId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Variation removed' } },
    },
  },

  // ── EOT (Extension of Time) ────────────────────────────────────────────────
  '/projects/{id}/eot': {
    get: {
      tags: ['Projects'],
      summary: 'List EOT claims',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of EOT claims' } },
    },
    post: {
      tags: ['Projects'],
      summary: 'Submit EOT claim',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['reason', 'days_requested'],
              properties: {
                reason:         { type: 'string' },
                days_requested: { type: 'integer' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'EOT claim submitted' } },
    },
  },

  '/projects/{id}/eot/analysis': {
    get: {
      tags: ['Projects'],
      summary: 'Get EOT impact analysis',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'EOT analysis with schedule impact' } },
    },
  },

  '/projects/{id}/eot/{claimId}': {
    patch: {
      tags: ['Projects'],
      summary: 'Update EOT claim',
      parameters: [
        { name: 'id',      in: 'path', required: true, schema: { type: 'string' } },
        { name: 'claimId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'Updated EOT claim' } },
    },
    delete: {
      tags: ['Projects'],
      summary: 'Remove EOT claim',
      parameters: [
        { name: 'id',      in: 'path', required: true, schema: { type: 'string' } },
        { name: 'claimId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'EOT claim removed' } },
    },
  },

  '/projects/{id}/eot/{claimId}/decision': {
    patch: {
      tags: ['Projects'],
      summary: 'Decide on EOT claim — updates completion date (business owner)',
      parameters: [
        { name: 'id',      in: 'path', required: true, schema: { type: 'string' } },
        { name: 'claimId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['decision'],
              properties: {
                decision:      { type: 'string', enum: ['approved', 'rejected', 'partial'] },
                days_approved: { type: 'integer' },
                notes:         { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'EOT decision recorded, completion date updated' } },
    },
  },

  // ── BILLING / INVOICES ─────────────────────────────────────────────────────
  '/projects/{id}/billing': {
    get: {
      tags: ['Projects'],
      summary: 'Get project billing summary',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Invoiced, paid and retention amounts' } },
    },
  },

  '/projects/{id}/invoices': {
    post: {
      tags: ['Projects'],
      summary: 'Create progress invoice for project',
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
                due_date:    { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Progress invoice created' } },
    },
  },

  '/projects/{id}/retention-release': {
    post: {
      tags: ['Projects'],
      summary: 'Release retention amount as invoice',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 201: { description: 'Retention release invoice created' } },
    },
  },

  '/projects/{id}/invoices/{invoiceId}/certificate': {
    get: {
      tags: ['Projects'],
      summary: 'Get payment certificate for a project invoice',
      parameters: [
        { name: 'id',        in: 'path', required: true, schema: { type: 'string' } },
        { name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Payment certificate data' } },
    },
  },

  // ── DOCUMENTS ──────────────────────────────────────────────────────────────
  '/projects/{id}/documents': {
    get: {
      tags: ['Projects'],
      summary: 'List project documents',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of documents' } },
    },
    post: {
      tags: ['Projects'],
      summary: 'Upload project document',
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

  '/projects/{id}/documents/{documentId}': {
    delete: {
      tags: ['Projects'],
      summary: 'Remove project document',
      parameters: [
        { name: 'id',         in: 'path', required: true, schema: { type: 'string' } },
        { name: 'documentId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Document removed' } },
    },
  },

  '/projects/{id}/documents/{documentId}/share': {
    patch: {
      tags: ['Projects'],
      summary: 'Toggle client portal visibility for a document',
      parameters: [
        { name: 'id',         in: 'path', required: true, schema: { type: 'string' } },
        { name: 'documentId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object', properties: { shared: { type: 'boolean' } } },
          },
        },
      },
      responses: { 200: { description: 'Share status updated' } },
    },
  },

  // ── MESSAGES ───────────────────────────────────────────────────────────────
  '/projects/{id}/messages': {
    get: {
      tags: ['Projects'],
      summary: 'List project messages',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of messages' } },
    },
    post: {
      tags: ['Projects'],
      summary: 'Post message to project',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
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

  // ── DIARY ──────────────────────────────────────────────────────────────────
  '/projects/{id}/diary': {
    get: {
      tags: ['Projects'],
      summary: 'List site diary entries',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of diary entries' } },
    },
    post: {
      tags: ['Projects'],
      summary: 'Save site diary entry',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['date'],
              properties: {
                date:    { type: 'string', format: 'date' },
                weather: { type: 'string' },
                notes:   { type: 'string' },
                workers: { type: 'integer' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Diary entry saved' } },
    },
  },

  '/projects/{id}/diary/{entryId}': {
    delete: {
      tags: ['Projects'],
      summary: 'Remove diary entry',
      parameters: [
        { name: 'id',      in: 'path', required: true, schema: { type: 'string' } },
        { name: 'entryId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Diary entry removed' } },
    },
  },

  // ── TIME LOGS ──────────────────────────────────────────────────────────────
  '/projects/{id}/time': {
    get: {
      tags: ['Projects'],
      summary: 'List time logs for project',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of time logs' } },
    },
    post: {
      tags: ['Projects'],
      summary: 'Log time on project',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['hours'],
              properties: {
                hours:       { type: 'number' },
                date:        { type: 'string', format: 'date' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Time logged' } },
    },
  },

  '/projects/{id}/time/{logId}': {
    delete: {
      tags: ['Projects'],
      summary: 'Remove time log',
      parameters: [
        { name: 'id',    in: 'path', required: true, schema: { type: 'string' } },
        { name: 'logId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Time log removed' } },
    },
  },

  // ── BASELINE & SCHEDULE ────────────────────────────────────────────────────
  '/projects/{id}/baseline': {
    get: {
      tags: ['Projects'],
      summary: 'List project baselines',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Array of baselines' } },
    },
    post: {
      tags: ['Projects'],
      summary: 'Set a new baseline snapshot',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: { type: 'object', properties: { label: { type: 'string' } } },
          },
        },
      },
      responses: { 201: { description: 'Baseline saved' } },
    },
  },

  '/projects/{id}/schedule': {
    get: {
      tags: ['Projects'],
      summary: 'Get project schedule (Gantt data)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Schedule with milestones and tasks' } },
    },
  },

  '/projects/{id}/cashflow': {
    get: {
      tags: ['Projects'],
      summary: 'Get project cash flow forecast',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Monthly cash flow forecast' } },
    },
  },

  // ── TRACKING LINK ──────────────────────────────────────────────────────────
  '/projects/{id}/track-link': {
    post: {
      tags: ['Projects'],
      summary: 'Generate client tracking link',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Tracking token and URL' } },
    },
    delete: {
      tags: ['Projects'],
      summary: 'Revoke client tracking link',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Tracking link revoked' } },
    },
  },
};
