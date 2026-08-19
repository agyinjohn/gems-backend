module.exports = {
  '/ess/me': {
    get: {
      tags: ['ESS'],
      summary: 'Get own employee profile + leave balances',
      responses: {
        200: { description: 'Employee object with leave balances, or null if no record linked' },
      },
    },
  },

  '/ess/leave-requests': {
    get: {
      tags: ['ESS'],
      summary: 'List own leave requests',
      responses: { 200: { description: 'Array of leave requests' } },
    },
    post: {
      tags: ['ESS'],
      summary: 'Submit a leave request',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['start_date', 'end_date'],
              properties: {
                leave_type: { type: 'string', default: 'annual' },
                start_date: { type: 'string', format: 'date' },
                end_date:   { type: 'string', format: 'date' },
                reason:     { type: 'string' },
              },
            },
          },
        },
      },
      responses: {
        201: { description: 'Leave request submitted' },
        404: { description: 'No employee record linked to this account' },
      },
    },
  },

  '/ess/leave-requests/{id}/cancel': {
    patch: {
      tags: ['ESS'],
      summary: 'Cancel own pending leave request',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Leave request cancelled' },
        400: { description: 'Only pending requests can be cancelled' },
      },
    },
  },

  '/ess/payslips': {
    get: {
      tags: ['ESS'],
      summary: 'List own payslips',
      parameters: [
        { name: 'month', in: 'query', schema: { type: 'integer' } },
        { name: 'year',  in: 'query', schema: { type: 'integer' } },
      ],
      responses: { 200: { description: 'Array of payroll runs (submitted / approved / paid)' } },
    },
  },

  '/ess/attendance': {
    get: {
      tags: ['ESS'],
      summary: 'Get own attendance (last 30 records)',
      responses: { 200: { description: 'Array of attendance records' } },
    },
  },

  '/ess/attendance/clock-in': {
    post: {
      tags: ['ESS'],
      summary: 'Clock in (self)',
      responses: {
        201: { description: 'Clocked in' },
        404: { description: 'No employee record linked' },
      },
    },
  },

  '/ess/attendance/clock-out': {
    post: {
      tags: ['ESS'],
      summary: 'Clock out (self)',
      responses: {
        200: { description: 'Clocked out' },
        404: { description: 'No employee record linked' },
      },
    },
  },

  '/ess/appraisals': {
    get: {
      tags: ['ESS'],
      summary: 'List own appraisals',
      responses: { 200: { description: 'Array of appraisals' } },
    },
  },

  '/ess/appraisals/{id}/acknowledge': {
    patch: {
      tags: ['ESS'],
      summary: 'Acknowledge an appraisal and optionally add comments',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                employee_comments: { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Appraisal acknowledged' } },
    },
  },
};
