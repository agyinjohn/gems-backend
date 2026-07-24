const hr = require('../services/hrService');
const audit = require('../utils/audit');

const listEmployees = async (req, res) => {
  const data = await hr.listEmployees(req.tenant_id, req.branchFilter);
  res.json({ success: true, data });
};

const getEmployee = async (req, res) => {
  const data = await hr.getEmployee(req.tenant_id, req.params.id);
  res.json({ success: true, data });
};

const listLinkableUsers = async (req, res) => {
  const data = await hr.listLinkableUsers(req.tenant_id, req.query.employee_id);
  res.json({ success: true, data });
};

const createEmployee = async (req, res) => {
  const data = await hr.createEmployee(req.tenant_id, req.body);
  await audit(req, 'CREATE_EMPLOYEE', 'hr', `${req.user.name} added employee "${data.name}"`, { employee_id: data._id });
  res.status(201).json({ success: true, data });
};

const updateEmployee = async (req, res) => {
  const data = await hr.updateEmployee(req.tenant_id, req.params.id, req.body);
  await audit(req, 'UPDATE_EMPLOYEE', 'hr', `${req.user.name} updated employee "${data.name}"`, { employee_id: data.id });
  res.json({ success: true, data });
};

const terminateEmployee = async (req, res) => {
  const data = await hr.terminateEmployee(req.tenant_id, req.params.id, req.body);
  await audit(req, 'TERMINATE_EMPLOYEE', 'hr', `${req.user.name} terminated employee "${data.name}"`, { employee_id: data._id });
  res.json({ success: true, message: 'Employee terminated.', data });
};

const approveLeave = async (req, res) => {
  const data = await hr.approveLeaveRequest(req.tenant_id, req.params.id, req.user._id, req.body.status);
  res.json({ success: true, data });
};

const runPayroll = async (req, res) => {
  const { employee_id, month, year, allowance_lines, deduction_lines } = req.body;
  if (!employee_id || !month || !year) {
    return res.status(400).json({ success: false, message: 'employee_id, month, and year are required.' });
  }
  const data = await hr.runPayroll(req.tenant_id, { employee_id, month, year, allowance_lines, deduction_lines });
  await audit(req, 'RUN_PAYROLL', 'hr', `${req.user.name} ran payroll for employee`, { payroll_id: data._id });
  res.status(201).json({ success: true, data });
};

const runBulkPayroll = async (req, res) => {
  const { month, year, allowance_lines, deduction_lines } = req.body;
  if (!month || !year) {
    return res.status(400).json({ success: false, message: 'month and year are required.' });
  }
  const data = await hr.runBulkPayroll(req.tenant_id, { month, year, allowance_lines, deduction_lines });
  await audit(req, 'RUN_BULK_PAYROLL', 'hr', `${req.user.name} ran bulk payroll for ${month}/${year}`, { created: data.created.length });
  res.status(201).json({ success: true, data });
};

const uploadDocument = async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file provided.' });
  const uploaded = await hr.uploadEmployeeDocument(req.tenant_id, req.params.id, req.file);
  const docs = await hr.addEmployeeDocument(req.tenant_id, req.params.id, {
    name: req.body.name || req.file.originalname,
    type: req.body.type || 'other',
    url: uploaded.url,
    mime_type: req.file.mimetype,
  });
  res.status(201).json({ success: true, data: { url: uploaded.url, documents: docs } });
};

const deleteDocument = async (req, res) => {
  await hr.deleteEmployeeDocument(req.tenant_id, req.params.id, req.params.docId);
  res.json({ success: true, message: 'Document deleted.' });
};

const hrSummary = async (req, res) => {
  const data = await hr.getHrSummary(req.tenant_id, req.query, req.branchFilter);
  res.json({ success: true, data });
};

const hrReport = async (req, res) => {
  const { from, to } = req.query;
  const data = await hr.getHrReportForRange(req.tenant_id, { from, to }, req.branchFilter);
  res.json({ success: true, data });
};

module.exports = {
  listEmployees,
  getEmployee,
  listLinkableUsers,
  createEmployee,
  updateEmployee,
  terminateEmployee,
  approveLeave,
  runPayroll,
  runBulkPayroll,
  uploadDocument,
  deleteDocument,
  hrSummary,
  hrReport,
};
