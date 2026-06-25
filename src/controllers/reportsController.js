const reports = require('../services/reportsService');

const getOverview = async (req, res) => {
  const data = await reports.getOverview(req.tenant_id, req.query);
  res.json({ success: true, data });
};

const getSales = async (req, res) => {
  const data = await reports.getSalesReport(req.tenant_id, req.query);
  res.json({ success: true, data });
};

const getInventory = async (req, res) => {
  const data = await reports.getInventoryReport(req.tenant_id, req.query);
  res.json({ success: true, data });
};

const getFinance = async (req, res) => {
  const data = await reports.getFinanceReport(req.tenant_id, req.query);
  res.json({ success: true, data });
};

const getHr = async (req, res) => {
  const data = await reports.getHrReport(req.tenant_id, req.query);
  res.json({ success: true, data });
};

const getProcurement = async (req, res) => {
  const data = await reports.getProcurementReport(req.tenant_id, req.query);
  res.json({ success: true, data });
};

const getCrm = async (req, res) => {
  const data = await reports.getCrmReport(req.tenant_id, req.query);
  res.json({ success: true, data });
};

const getBranches = async (req, res) => {
  const data = await reports.listReportBranches(req.tenant_id);
  res.json({ success: true, data });
};

module.exports = {
  getOverview,
  getSales,
  getInventory,
  getFinance,
  getHr,
  getProcurement,
  getCrm,
  getBranches,
};
