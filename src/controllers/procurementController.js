const procurement = require('../services/procurementService');

function handleError(res, err) {
  const status = err.status || 500;
  res.status(status).json({ success: false, message: err.message || 'Request failed.' });
}

const listSuppliers = async (req, res) => {
  try {
    const data = await procurement.listSuppliers(req.tenant_id);
    res.json({ success: true, data });
  } catch (err) { handleError(res, err); }
};

const createSupplier = async (req, res) => {
  try {
    const data = await procurement.createSupplier(req.tenant_id, req.body);
    res.status(201).json({ success: true, data });
  } catch (err) { handleError(res, err); }
};

const updateSupplier = async (req, res) => {
  try {
    const data = await procurement.updateSupplier(req.tenant_id, req.params.id, req.body);
    res.json({ success: true, data });
  } catch (err) { handleError(res, err); }
};

const deactivateSupplier = async (req, res) => {
  try {
    await procurement.deactivateSupplier(req.tenant_id, req.params.id);
    res.json({ success: true, message: 'Supplier deactivated.' });
  } catch (err) { handleError(res, err); }
};

const listPurchaseOrders = async (req, res) => {
  try {
    const data = await procurement.listPurchaseOrders(req.tenant_id, req.query, req.branchFilter);
    res.json({ success: true, data });
  } catch (err) { handleError(res, err); }
};

const getPurchaseOrder = async (req, res) => {
  try {
    const data = await procurement.getPurchaseOrder(req.tenant_id, req.params.id);
    res.json({ success: true, data });
  } catch (err) { handleError(res, err); }
};

const createPurchaseOrder = async (req, res) => {
  try {
    const data = await procurement.createPurchaseOrder(
      req.tenant_id,
      req.user._id,
      req.user.branch_id,
      req.body,
    );
    res.status(201).json({ success: true, data });
  } catch (err) { handleError(res, err); }
};

const updatePurchaseOrder = async (req, res) => {
  try {
    const data = await procurement.updatePurchaseOrder(req.tenant_id, req.params.id, req.body);
    res.json({ success: true, data });
  } catch (err) { handleError(res, err); }
};

const submitPurchaseOrder = async (req, res) => {
  try {
    const data = await procurement.submitPurchaseOrder(req.tenant_id, req.params.id);
    res.json({ success: true, data, message: 'PO submitted for approval.' });
  } catch (err) { handleError(res, err); }
};

const approvePurchaseOrder = async (req, res) => {
  try {
    const data = await procurement.approvePurchaseOrder(req.tenant_id, req.user._id, req.params.id);
    res.json({ success: true, data });
  } catch (err) { handleError(res, err); }
};

const sendPurchaseOrder = async (req, res) => {
  try {
    const data = await procurement.sendPurchaseOrder(req.tenant_id, req.params.id);
    res.json({ success: true, data });
  } catch (err) { handleError(res, err); }
};

const cancelPurchaseOrder = async (req, res) => {
  try {
    const data = await procurement.cancelPurchaseOrder(req.tenant_id, req.params.id, req.body.reason);
    res.json({ success: true, data, message: 'PO cancelled.' });
  } catch (err) { handleError(res, err); }
};

const receiveGoods = async (req, res) => {
  try {
    await procurement.receiveGoods(req.tenant_id, req.user._id, req.params.id, req.body.items);
    res.json({ success: true, message: 'Goods received.' });
  } catch (err) { handleError(res, err); }
};

const payPurchaseOrder = async (req, res) => {
  try {
    const result = await procurement.payPurchaseOrder(req.tenant_id, req.user._id, req.params.id, req.body);
    res.json({ success: true, data: result.po, paid: result.paid, outstanding: result.outstanding });
  } catch (err) { handleError(res, err); }
};

module.exports = {
  listSuppliers,
  createSupplier,
  updateSupplier,
  deactivateSupplier,
  listPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  submitPurchaseOrder,
  approvePurchaseOrder,
  sendPurchaseOrder,
  cancelPurchaseOrder,
  receiveGoods,
  payPurchaseOrder,
};
