const { Supplier, PurchaseOrder, Product, StockMovement } = require('../models');
const logPayment = require('../utils/paymentLog');
const accounting = require('./accountingService');

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

async function enrichPoItems(tenantId, items) {
  let total_cost = 0;
  const enriched = [];
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, tenant_id: tenantId });
    if (!p) throw httpError('Product not found.');
    const qty = parseInt(item.quantity_ordered, 10) || 0;
    const unitCost = parseFloat(item.unit_cost);
    if (qty <= 0 || Number.isNaN(unitCost) || unitCost < 0) {
      throw httpError('Each line needs a valid quantity and unit cost.');
    }
    const itemTotal = unitCost * qty;
    total_cost += itemTotal;
    enriched.push({
      product_id: p._id,
      product_name: p.name,
      quantity_ordered: qty,
      quantity_received: 0,
      unit_cost: unitCost,
      total: itemTotal,
    });
  }
  return { enriched, total_cost };
}

async function listSuppliers(tenantId) {
  return Supplier.find({ tenant_id: tenantId, is_active: true }).sort('name');
}

async function createSupplier(tenantId, body) {
  const { name, email, phone, address, payment_terms, notes } = body;
  if (!name) throw httpError('Supplier name is required.');
  return Supplier.create({ tenant_id: tenantId, name, email, phone, address, payment_terms, notes });
}

async function updateSupplier(tenantId, id, body) {
  const { name, email, phone, address, payment_terms, notes } = body;
  const data = await Supplier.findOneAndUpdate(
    { _id: id, tenant_id: tenantId },
    { name, email, phone, address, payment_terms, notes },
    { new: true },
  );
  if (!data) throw httpError('Supplier not found.', 404);
  return data;
}

async function deactivateSupplier(tenantId, id) {
  const data = await Supplier.findOneAndUpdate(
    { _id: id, tenant_id: tenantId },
    { is_active: false },
    { new: true },
  );
  if (!data) throw httpError('Supplier not found.', 404);
  return data;
}

function buildPoListFilter(tenantId, query) {
  const filter = { tenant_id: tenantId };
  if (query.status) {
    const statuses = String(query.status).split(',');
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (query.payment_status) filter.payment_status = query.payment_status;
  if (query.branch_id) filter.branch_id = query.branch_id;
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(`${query.to}T23:59:59.999`);
  }
  return filter;
}

async function listPurchaseOrders(tenantId, query, branchFilter = {}) {
  // branchFilter is authoritative (server-resolved) and overrides any
  // client-supplied query.branch_id handled inside buildPoListFilter.
  const filter = { ...buildPoListFilter(tenantId, query), ...branchFilter };
  return PurchaseOrder.find(filter).populate('supplier_id', 'name').sort({ createdAt: -1 });
}

async function getPurchaseOrder(tenantId, id) {
  const po = await PurchaseOrder.findOne({ _id: id, tenant_id: tenantId }).populate('supplier_id', 'name');
  if (!po) throw httpError('PO not found.', 404);
  return po;
}

async function createPurchaseOrder(tenantId, userId, branchId, body) {
  const { supplier_id, expected_date, notes, items } = body;
  if (!supplier_id || !items?.length) throw httpError('supplier_id and items required.');
  const { enriched, total_cost } = await enrichPoItems(tenantId, items);
  return PurchaseOrder.create({
    tenant_id: tenantId,
    branch_id: branchId || null,
    po_number: `PO-${Date.now()}`,
    supplier_id,
    total_cost,
    items: enriched,
    notes,
    expected_date: expected_date || null,
    created_by: userId,
    status: 'draft',
  });
}

async function updatePurchaseOrder(tenantId, id, body) {
  const po = await PurchaseOrder.findOne({ _id: id, tenant_id: tenantId });
  if (!po) throw httpError('PO not found.', 404);
  if (po.status !== 'draft') throw httpError('Only draft POs can be edited.');

  const { supplier_id, expected_date, notes, items } = body;
  if (!supplier_id || !items?.length) throw httpError('supplier_id and items required.');
  const { enriched, total_cost } = await enrichPoItems(tenantId, items);

  po.supplier_id = supplier_id;
  po.expected_date = expected_date || null;
  po.notes = notes || '';
  po.items = enriched;
  po.total_cost = total_cost;
  await po.save();
  return po.populate('supplier_id', 'name');
}

async function submitPurchaseOrder(tenantId, id) {
  const po = await PurchaseOrder.findOne({ _id: id, tenant_id: tenantId });
  if (!po) throw httpError('PO not found.', 404);
  if (po.status !== 'draft') throw httpError('Only draft POs can be submitted for approval.');
  po.status = 'pending_approval';
  await po.save();
  return po;
}

async function approvePurchaseOrder(tenantId, userId, id) {
  const po = await PurchaseOrder.findOne({ _id: id, tenant_id: tenantId });
  if (!po) throw httpError('PO not found.', 404);
  if (!['draft', 'pending_approval'].includes(po.status)) {
    throw httpError('Only draft or pending-approval POs can be approved.');
  }
  po.status = 'approved';
  po.approved_by = userId;
  po.approved_at = new Date();
  await po.save();
  return po;
}

async function sendPurchaseOrder(tenantId, id) {
  const po = await PurchaseOrder.findOne({ _id: id, tenant_id: tenantId });
  if (!po) throw httpError('PO not found.', 404);
  if (po.status !== 'approved') throw httpError('Only approved POs can be marked as sent.');
  po.status = 'sent';
  await po.save();
  return po;
}

async function cancelPurchaseOrder(tenantId, id, reason) {
  const po = await PurchaseOrder.findOne({ _id: id, tenant_id: tenantId });
  if (!po) throw httpError('PO not found.', 404);
  if (['completed', 'cancelled'].includes(po.status)) {
    throw httpError('This PO cannot be cancelled.');
  }
  const anyReceived = po.items.some((i) => (i.quantity_received || 0) > 0);
  if (anyReceived) throw httpError('Cannot cancel a PO that has already received goods.');
  po.status = 'cancelled';
  if (reason) {
    po.notes = po.notes ? `${po.notes}\n\nCancelled: ${reason}` : `Cancelled: ${reason}`;
  }
  await po.save();
  return po;
}

async function receiveGoods(tenantId, userId, id, items) {
  const po = await PurchaseOrder.findOne({ _id: id, tenant_id: tenantId });
  if (!po) throw httpError('PO not found.', 404);
  if (po.status === 'cancelled') throw httpError('Cancelled PO cannot receive goods.');
  if (!['approved', 'sent', 'partially_received'].includes(po.status)) {
    throw httpError('PO is not ready for receiving.');
  }

  let receivedTotal = 0;
  let receivedAny = false;

  for (const item of items || []) {
    const qty = parseInt(item.receive_qty, 10) || 0;
    if (qty <= 0) continue;

    const lineId = item._id || item.id;
    const line = po.items.id(lineId);
    if (!line) throw httpError(`PO line not found for ${item.product_name || 'item'}.`);

    const remaining = line.quantity_ordered - (line.quantity_received || 0);
    if (qty > remaining) {
      throw httpError(`Cannot receive ${qty} of ${line.product_name}; only ${remaining} remaining.`);
    }

    const product = await Product.findOne({ _id: line.product_id, tenant_id: tenantId });
    if (!product) throw httpError(`Product ${line.product_name} not found.`);

    line.quantity_received = (line.quantity_received || 0) + qty;
    receivedTotal += qty * (line.unit_cost || 0);
    receivedAny = true;

    const update = { $inc: { stock_qty: qty } };
    if (line.unit_cost > 0) update.$set = { cost_price: line.unit_cost };
    await Product.findByIdAndUpdate(line.product_id, update);

    await StockMovement.create({
      tenant_id: tenantId,
      product_id: line.product_id,
      type: 'purchase',
      quantity: qty,
      reference: po.po_number,
      created_by: userId,
    });
  }

  if (!receivedAny) throw httpError('Enter at least one quantity to receive.');

  const allDone = po.items.every((i) => (i.quantity_received || 0) >= i.quantity_ordered);
  po.status = allDone ? 'completed' : 'partially_received';
  await po.save();

  if (receivedTotal > 0) {
    await accounting.postPurchaseOrderEntry({
      tenantId,
      amount: receivedTotal,
      reference: po.po_number,
      date: new Date(),
      sourceId: po._id,
      createdBy: userId,
    }).catch((err) => console.error('[Procurement] Receive GL failed:', err.message));
  }

  return po;
}

async function payPurchaseOrder(tenantId, userId, id, body) {
  const po = await PurchaseOrder.findOne({ _id: id, tenant_id: tenantId });
  if (!po) throw httpError('PO not found.', 404);
  if (po.payment_status === 'paid') throw httpError('Already fully paid.');

  const { amount, method = 'bank_transfer', reference, note } = body;
  const alreadyPaid = po.amount_paid || 0;
  const outstanding = po.total_cost - alreadyPaid;
  const paying = amount ? Math.min(parseFloat(amount), outstanding) : outstanding;
  if (paying <= 0) throw httpError('Nothing left to pay on this PO.');

  po.amount_paid = parseFloat((alreadyPaid + paying).toFixed(2));
  po.payment_status = po.amount_paid >= po.total_cost - 0.01 ? 'paid' : 'partial';
  if (po.payment_status === 'paid') po.paid_at = new Date();

  if (!po.payments) po.payments = [];
  po.payments.push({ amount: paying, method, reference: reference || null, note: note || null, date: new Date() });
  await po.save();

  await logPayment({
    tenant_id: tenantId,
    source: 'purchase_order',
    reference: po.po_number,
    amount: paying,
    method,
    status: 'success',
    description: `Supplier payment — ${po.po_number}${reference ? ` ref: ${reference}` : ''}`,
    source_id: po._id,
    recorded_by: userId,
  });

  await accounting.postPurchasePaymentEntry({
    tenantId,
    amount: paying,
    reference: `${po.po_number}-${Date.now()}`,
    date: new Date(),
    sourceId: po._id,
    createdBy: userId,
  }).catch((err) => console.error('[Procurement] Payment GL failed:', err.message));

  return {
    po,
    paid: paying,
    outstanding: parseFloat((po.total_cost - po.amount_paid).toFixed(2)),
  };
}

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
