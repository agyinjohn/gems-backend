module.exports = {
  // ── DEPARTMENTS ────────────────────────────────────────────────────────────
  '/departments': {
    get: {
      tags: ['HR'],
      summary: 'List departments',
      responses: { 200: { description: 'Array of departments' } },
    },
    post: {
      tags: ['HR'],
      summary: 'Create department (business owner / HR manager)',
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
      responses: { 201: { description: 'Department created' } },
    },
  },

  '/departments/{id}': {
    put: {
      tags: ['HR'],
      summary: 'Update department',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated department' } },
    },
  },

  // ── EMPLOYEES ──────────────────────────────────────────────────────────────
  '/employees': {
    get: {
      tags: ['HR'],
      summary: 'List employees',
      responses: { 200: { description: 'Array of employees' } },
    },
    post: {
      tags: ['HR'],
      summary: 'Create employee (business owner / HR manager)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'email'],
              properties: {
                name:            { type: 'string' },
                email:           { type: 'string', format: 'email' },
                phone:           { type: 'string' },
                department_id:   { type: 'string' },
                branch_id:       { type: 'string' },
                job_title:       { type: 'string' },
                employment_type: { type: 'string', enum: ['full_time', 'part_time', 'contract'] },
                start_date:      { type: 'string', format: 'date' },
                basic_salary:    { type: 'number' },
                bank_name:       { type: 'string' },
                bank_account_number: { type: 'string' },
                momo_number:     { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Employee created' } },
    },
  },

  '/employees/linkable-users': {
    get: {
      tags: ['HR'],
      summary: 'List users that can be linked to an employee record',
      responses: { 200: { description: 'Array of users' } },
    },
  },

  '/employees/{id}': {
    get: {
      tags: ['HR'],
      summary: 'Get employee by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: { description: 'Employee object' },
        404: { $ref: '#/components/responses/NotFound' },
      },
    },
    put: {
      tags: ['HR'],
      summary: 'Update employee',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated employee' } },
    },
  },

  '/employees/{id}/terminate': {
    patch: {
      tags: ['HR'],
      summary: 'Terminate employee',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                termination_date:   { type: 'string', format: 'date' },
                termination_reason: { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Employee terminated' } },
    },
  },

  '/employees/{id}/documents': {
    post: {
      tags: ['HR'],
      summary: 'Upload employee document',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: { file: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Document uploaded' } },
    },
  },

  '/employees/{id}/documents/{docId}': {
    delete: {
      tags: ['HR'],
      summary: 'Delete employee document',
      parameters: [
        { name: 'id',    in: 'path', required: true, schema: { type: 'string' } },
        { name: 'docId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  // ── ATTENDANCE ─────────────────────────────────────────────────────────────
  '/attendance': {
    get: {
      tags: ['HR'],
      summary: 'List attendance records',
      parameters: [
        { name: 'date',        in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'employee_id', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of attendance records' } },
    },
    post: {
      tags: ['HR'],
      summary: 'Create / upsert attendance record (HR manager)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['employee_id', 'date'],
              properties: {
                employee_id: { type: 'string' },
                date:        { type: 'string', format: 'date' },
                status:      { type: 'string', enum: ['present', 'absent', 'late', 'half_day'] },
                clock_in:    { type: 'string', format: 'date-time' },
                clock_out:   { type: 'string', format: 'date-time' },
                notes:       { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Attendance record saved' } },
    },
  },

  '/attendance/clock-in': {
    post: {
      tags: ['HR'],
      summary: 'Clock in employee (HR manager on behalf)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['employee_id'],
              properties: { employee_id: { type: 'string' } },
            },
          },
        },
      },
      responses: { 201: { description: 'Clocked in' } },
    },
  },

  '/attendance/clock-out': {
    post: {
      tags: ['HR'],
      summary: 'Clock out employee (HR manager on behalf)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['employee_id'],
              properties: { employee_id: { type: 'string' } },
            },
          },
        },
      },
      responses: { 200: { description: 'Clocked out' } },
    },
  },

  '/hr/attendance-settings': {
    get: {
      tags: ['HR'],
      summary: 'Get attendance settings (standard hours, overtime multiplier)',
      responses: { 200: { description: 'Attendance settings' } },
    },
    patch: {
      tags: ['HR'],
      summary: 'Update attendance settings (business owner)',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                standard_hours_per_day: { type: 'number', example: 8 },
                overtime_multiplier:    { type: 'number', example: 1.5 },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated settings' } },
    },
  },

  // ── LEAVE TYPES ────────────────────────────────────────────────────────────
  '/leave-types': {
    get: {
      tags: ['HR'],
      summary: 'List leave types',
      responses: { 200: { description: 'Array of leave types' } },
    },
    post: {
      tags: ['HR'],
      summary: 'Create leave type',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: {
                name:          { type: 'string' },
                days_per_year: { type: 'integer' },
                is_paid:       { type: 'boolean' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Leave type created' } },
    },
  },

  '/leave-types/{id}': {
    patch: {
      tags: ['HR'],
      summary: 'Update leave type',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated leave type' } },
    },
  },

  // ── PUBLIC HOLIDAYS ────────────────────────────────────────────────────────
  '/holidays': {
    get: {
      tags: ['HR'],
      summary: 'List public holidays',
      parameters: [{ name: 'year', in: 'query', schema: { type: 'integer' } }],
      responses: { 200: { description: 'Array of holidays' } },
    },
    post: {
      tags: ['HR'],
      summary: 'Create public holiday',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name', 'date'],
              properties: {
                name: { type: 'string' },
                date: { type: 'string', format: 'date' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Holiday created' } },
    },
  },

  '/holidays/{id}': {
    delete: {
      tags: ['HR'],
      summary: 'Delete public holiday',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  // ── LEAVE REQUESTS ─────────────────────────────────────────────────────────
  '/leave-requests': {
    get: {
      tags: ['HR'],
      summary: 'List leave requests',
      responses: { 200: { description: 'Array of leave requests with employee names' } },
    },
    post: {
      tags: ['HR'],
      summary: 'Create leave request (HR manager on behalf)',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['employee_id', 'start_date', 'end_date'],
              properties: {
                employee_id: { type: 'string' },
                leave_type:  { type: 'string', default: 'annual' },
                start_date:  { type: 'string', format: 'date' },
                end_date:    { type: 'string', format: 'date' },
                reason:      { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Leave request created' } },
    },
  },

  '/leave-requests/{id}': {
    patch: {
      tags: ['HR'],
      summary: 'Approve or reject leave request',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['status'],
              properties: {
                status: { type: 'string', enum: ['approved', 'rejected'] },
                notes:  { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Leave request updated' } },
    },
  },

  // ── PAYROLL ────────────────────────────────────────────────────────────────
  '/payroll': {
    get: {
      tags: ['HR'],
      summary: 'List payroll runs',
      responses: { 200: { description: 'Array of payroll runs with employee names' } },
    },
    post: {
      tags: ['HR'],
      summary: 'Run payroll for a single employee',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['employee_id', 'month', 'year'],
              properties: {
                employee_id: { type: 'string' },
                month:       { type: 'integer', minimum: 1, maximum: 12 },
                year:        { type: 'integer' },
                allowances:  { type: 'number' },
                deductions:  { type: 'number' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Payroll run created' } },
    },
  },

  '/payroll/bulk': {
    post: {
      tags: ['HR'],
      summary: 'Run payroll for all employees in a period',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['month', 'year'],
              properties: {
                month: { type: 'integer', minimum: 1, maximum: 12 },
                year:  { type: 'integer' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Bulk payroll runs created' } },
    },
  },

  '/payroll/{id}/approve': {
    patch: {
      tags: ['HR'],
      summary: 'Approve payroll run (business owner / accountant)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Payroll approved, GL posted' } },
    },
  },

  // ── PAYROLL SETTINGS ───────────────────────────────────────────────────────
  '/hr/payroll-settings': {
    get: {
      tags: ['HR'],
      summary: 'Get payroll settings (SSNIT, PAYE bands)',
      responses: { 200: { description: 'Payroll settings with in-force rates' } },
    },
    patch: {
      tags: ['HR'],
      summary: 'Update payroll settings (business owner)',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                apply_ssnit:   { type: 'boolean' },
                apply_paye:    { type: 'boolean' },
                paye_bands:    { type: 'array', items: { type: 'object' } },
                pension_rates: { type: 'object' },
              },
            },
          },
        },
      },
      responses: { 200: { description: 'Updated payroll settings' } },
    },
  },

  // ── PAYROLL BATCHES ────────────────────────────────────────────────────────
  '/payroll/batches': {
    get: {
      tags: ['HR'],
      summary: 'List payroll batches',
      responses: { 200: { description: 'Array of payroll batches' } },
    },
    post: {
      tags: ['HR'],
      summary: 'Run a payroll batch for a period',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['month', 'year'],
              properties: {
                month:     { type: 'integer' },
                year:      { type: 'integer' },
                label:     { type: 'string' },
                branch_id: { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Payroll batch created' } },
    },
  },

  '/payroll/batches/{id}': {
    get: {
      tags: ['HR'],
      summary: 'Get payroll batch detail',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Batch with individual runs' } },
    },
  },

  '/payroll/batches/{id}/approve': {
    patch: {
      tags: ['HR'],
      summary: 'Approve payroll batch (business owner / accountant)',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Batch approved, GL posted' } },
    },
  },

  '/payroll/batches/{id}/mark-paid': {
    patch: {
      tags: ['HR'],
      summary: 'Mark payroll batch as paid',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Batch marked paid' } },
    },
  },

  '/payroll/batches/{id}/bank-file': {
    get: {
      tags: ['HR'],
      summary: 'Download bank payment CSV for a payroll batch',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'CSV file',
          content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
        },
      },
    },
  },

  // ── HR SETTINGS ────────────────────────────────────────────────────────────
  '/hr/settings': {
    get: {
      tags: ['HR'],
      summary: 'Get HR settings (leave defaults, payslip branding)',
      responses: { 200: { description: 'HR settings object' } },
    },
    patch: {
      tags: ['HR'],
      summary: 'Update HR settings (business owner)',
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated HR settings' } },
    },
  },

  '/hr/summary': {
    get: {
      tags: ['HR'],
      summary: 'Get HR summary KPIs',
      responses: { 200: { description: 'HR summary object' } },
    },
  },

  '/hr/report': {
    get: {
      tags: ['HR'],
      summary: 'Get HR report',
      responses: { 200: { description: 'HR report data' } },
    },
  },

  // ── LOANS ──────────────────────────────────────────────────────────────────
  '/loans': {
    get: {
      tags: ['HR'],
      summary: 'List employee loans / salary advances',
      parameters: [
        { name: 'employee_id', in: 'query', schema: { type: 'string' } },
        { name: 'status',      in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of loans' } },
    },
    post: {
      tags: ['HR'],
      summary: 'Create employee loan',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['employee_id', 'amount'],
              properties: {
                employee_id:      { type: 'string' },
                amount:           { type: 'number' },
                repayment_months: { type: 'integer' },
                notes:            { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Loan created' } },
    },
  },

  '/loans/{id}': {
    get: {
      tags: ['HR'],
      summary: 'Get loan detail',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Loan object' } },
    },
  },

  '/loans/{id}/cancel': {
    patch: {
      tags: ['HR'],
      summary: 'Cancel loan',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Loan cancelled' } },
    },
  },

  // ── APPRAISALS ─────────────────────────────────────────────────────────────
  '/appraisals': {
    get: {
      tags: ['HR'],
      summary: 'List performance appraisals',
      parameters: [
        { name: 'employee_id', in: 'query', schema: { type: 'string' } },
      ],
      responses: { 200: { description: 'Array of appraisals' } },
    },
    post: {
      tags: ['HR'],
      summary: 'Create appraisal',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['employee_id', 'period'],
              properties: {
                employee_id: { type: 'string' },
                period:      { type: 'string', example: 'Q1 2025' },
                scores:      { type: 'object' },
                comments:    { type: 'string' },
              },
            },
          },
        },
      },
      responses: { 201: { description: 'Appraisal created' } },
    },
  },

  '/appraisals/categories': {
    get: {
      tags: ['HR'],
      summary: 'Get appraisal scoring categories',
      responses: { 200: { description: 'Array of categories' } },
    },
  },

  '/appraisals/{id}': {
    get: {
      tags: ['HR'],
      summary: 'Get appraisal by ID',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Appraisal object' } },
    },
    put: {
      tags: ['HR'],
      summary: 'Update appraisal',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { 200: { description: 'Updated appraisal' } },
    },
    delete: {
      tags: ['HR'],
      summary: 'Delete appraisal',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Deleted' } },
    },
  },

  '/appraisals/{id}/submit': {
    patch: {
      tags: ['HR'],
      summary: 'Submit appraisal',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'Appraisal submitted' } },
    },
  },
};
