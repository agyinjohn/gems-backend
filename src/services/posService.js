const { Product, StockMovement, Order, PosShift } = require('../models');
const logPayment = require('../utils/paymentLog');
const accounting = require('./accountingService');
const { sendOrderConfirmation } = require('./notificationService');
const { verifyPaystackTransaction } = require('./paymentService');
const { clearCustomerDisplayByOrderId, setPaidDisplayFlash } = require('./posDisplayService');

async function getOpenShift(tenantId, userId, branchId) {
  const filter = { tenant_id: tenantId, opened_by: userId, status: 'open' };
  // When a branch context is given, resolve the shift for that branch.
  // Legacy shifts opened before branch stamping (branch_id null) still match
  // so they remain visible and closable.
  if (branchId !== undefined) filter.$or = [{ branch_id: branchId }, { branch_id: null }];
  return PosShift.findOne(filter).sort({ opened_at: -1 });
}

async function requireOpenShift(tenantId, userId, branchId) {
  const shift = await getOpenShift(tenantId, userId, branchId);
  if (!shift) {
    throw Object.assign(new Error('Open a shift before making sales.'), { status: 403 });
  }
  return shift;
}

async function recordShiftSale(shiftId, { amount, payment_method }) {
  if (!shiftId) return;
  const inc = { sales_count: 1, sales_total: amount };
  const method = payment_method === 'paystack' ? 'momo' : payment_method;
  const shiftMethod = method === 'card_terminal' ? 'card' : method;
  if (shiftMethod === 'cash') inc.expected_cash = amount;
  else if (shiftMethod === 'card') inc.card_total = amount;
  else if (shiftMethod === 'momo') inc.momo_total = amount;
  await PosShift.findByIdAndUpdate(shiftId, { $inc: inc });
}

async function recordShiftRefund(shiftId, amount, paymentMethod) {
  if (!shiftId) return;
  const inc = { refunds_total: amount };
  if (paymentMethod === 'cash') inc.expected_cash = -amount;
  await PosShift.findByIdAndUpdate(shiftId, { $inc: inc });
}

async function completePosSale({
  tenantId,
  userId,
  branchId,
  items,
  payment_method,
  payment_ref,
  customer_name,
  customer_phone,
  shift_id,
  amount_tendered,
  fromReservation = false,
  // Set only when Paystack collected the money. payment_method records the
  // channel the customer used, which cannot distinguish a Paystack MoMo
  // payment from one sent straight to the shop.
  paystack_settled = false,
  split_settled = false,
  subaccount_code = null,
}) {
  let subtotal = 0;
  let cogsTotal = 0;
  const enrichedItems = [];

  // Fetch tenant tax rate
  const { Tenant } = require('../models');
  const tenantDoc = await Tenant.findById(tenantId).select('storefront_settings').lean();
  const taxRate = Number(tenantDoc?.storefront_settings?.tax_rate || 0);

  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, tenant_id: tenantId, is_active: true });
    if (!p) throw Object.assign(new Error(`Product not found.`), { status: 400 });
    const isService = p.item_type === 'service';
    if (!isService) {
      if (fromReservation) {
        if ((p.reserved_qty || 0) < item.quantity) {
          throw Object.assign(new Error(`Insufficient stock for ${p.name}.`), { status: 400 });
        }
      } else if (p.stock_qty - (p.reserved_qty || 0) < item.quantity) {
        throw Object.assign(new Error(`Insufficient stock for ${p.name}.`), { status: 400 });
      }
    }
    const total = p.price * item.quantity;
    subtotal += total;
    cogsTotal += (p.cost_price || 0) * item.quantity;
    enrichedItems.push({ product_id: p._id, product_name: p.name, quantity: item.quantity, unit_price: p.price, total, item_type: p.item_type || 'product' });
  }

  const orderNumber = `POS-${Date.now()}-${Math.floor(Math.random() * 100)}`;
  const computedTax = taxRate > 0 ? Math.round(subtotal * taxRate / 100 * 100) / 100 : 0;
  const grandTotal = subtotal + computedTax;
  const order = await Order.create({
    tenant_id: tenantId,
    branch_id: branchId || null,
    shift_id: shift_id || null,
    order_number: orderNumber,
    customer_name: customer_name || 'Walk-in Customer',
    customer_phone: customer_phone || '',
    subtotal,
    tax_amount: computedTax,
    total: grandTotal,
    payment_status: 'paid',
    payment_method: payment_method || 'cash',
    payment_ref: payment_ref || null,
    paystack_settled: !!paystack_settled,
    split_settled: !!split_settled,
    subaccount_code: subaccount_code || undefined,
    status: 'delivered',
    source: 'pos',
    items: enrichedItems,
    created_by: userId,
  });

  for (const item of enrichedItems) {
    if (item.item_type === 'service') continue;
    const stockUpdate = fromReservation
      ? { $inc: { stock_qty: -item.quantity, reserved_qty: -item.quantity } }
      : { $inc: { stock_qty: -item.quantity } };
    const updated = await Product.findOneAndUpdate(
      { _id: item.product_id, tenant_id: tenantId },
      stockUpdate,
      { new: true },
    );
    if (updated && updated.reserved_qty < 0) {
      await Product.findByIdAndUpdate(updated._id, { reserved_qty: 0 });
    }
    await StockMovement.create({
      tenant_id: tenantId,
      product_id: item.product_id,
      type: 'sale',
      quantity: -item.quantity,
      reference: orderNumber,
      created_by: userId,
    });
  }

  await logPayment({
    tenant_id: tenantId,
    source: 'pos',
    reference: orderNumber,
    amount: grandTotal,
    method: payment_method || 'cash',
    status: 'success',
    payer_name: customer_name || 'Walk-in Customer',
    description: `POS sale ${orderNumber}`,
    source_id: order._id,
    recorded_by: userId,
  });

  const posHasProduct = enrichedItems.some((i) => i.item_type !== 'service');
  const posHasService = enrichedItems.some((i) => i.item_type === 'service');
  const posRevenueAccountCode = posHasProduct ? '4001' : posHasService ? '4010' : '4001';
  await accounting.postSaleEntry({
    tenantId,
    amount: grandTotal,
    cogsAmount: cogsTotal,
    taxAmount: computedTax,
    reference: orderNumber,
    date: new Date(),
    sourceId: order._id,
    createdBy: userId,
    revenueAccountCode: posRevenueAccountCode,
  }).catch((err) => console.error('[POS] GL posting failed:', err.message));

  await sendOrderConfirmation({
    tenantId,
    order,
    customerEmail: null,
    customerPhone: customer_phone,
    channel: 'pos',
  }).catch(() => {});

  await recordShiftSale(shift_id, { amount: grandTotal, payment_method });

  const tendered = parseFloat(amount_tendered) || grandTotal;
  return {
    order,
    change: payment_method === 'cash' ? Math.max(0, tendered - grandTotal) : 0,
    amount_tendered: tendered,
  };
}

/**
 * Verify Paystack payment and complete a pending POS sale.
 * Idempotent — safe for client verify + webhook retry.
 */
async function fulfillPosPaystackOrder({ tenantId, orderId, reference, userId, branchId, amount_tendered }) {
  const paystackData = await verifyPaystackTransaction(reference);

  let pending = null;
  if (orderId) {
    const q = { _id: orderId, source: 'pos', payment_status: 'pending' };
    if (tenantId) q.tenant_id = tenantId;
    pending = await Order.findOne(q);
  }
  if (!pending) {
    const q = { payment_ref: reference, source: 'pos', payment_status: 'pending' };
    if (tenantId) q.tenant_id = tenantId;
    pending = await Order.findOne(q);
  }
  if (!pending && paystackData?.metadata?.pos_order_id) {
    const q = { _id: paystackData.metadata.pos_order_id, source: 'pos', payment_status: 'pending' };
    if (tenantId) q.tenant_id = tenantId;
    pending = await Order.findOne(q);
  }

  if (!pending) {
    const paidQ = { payment_ref: reference, source: 'pos', payment_status: 'paid' };
    if (tenantId) paidQ.tenant_id = tenantId;
    const paid = await Order.findOne(paidQ);
    if (paid) {
      return { order: paid, change: 0, amount_tendered: paid.total, already_fulfilled: true };
    }
    const err = new Error('Pending POS order not found.');
    err.status = 404;
    throw err;
  }

  const channel = paystackData?.channel;
  let paymentMethod = pending.payment_method || 'card';
  if (channel === 'mobile_money' || channel === 'ussd') paymentMethod = 'momo';
  else if (channel === 'card') paymentMethod = 'card';
  else if (pending.payment_method === 'card_terminal') paymentMethod = 'card';

  const result = await completePosSale({
    tenantId: pending.tenant_id,
    userId: userId || pending.created_by,
    branchId: branchId ?? pending.branch_id,
    items: pending.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
    payment_method: paymentMethod,
    payment_ref: reference,
    customer_name: pending.customer_name,
    customer_phone: pending.customer_phone,
    shift_id: pending.shift_id,
    amount_tendered,
    fromReservation: true,
    // Paystack collected this one, so it counts towards the withdrawable
    // balance — unless it was split, in which case the shop was already paid
    // directly and the pending order carries the subaccount it went to.
    paystack_settled: true,
    split_settled: !!pending.split_settled,
    subaccount_code: pending.subaccount_code || null,
  });

  await Order.findByIdAndDelete(pending._id);
  await clearCustomerDisplayByOrderId(pending._id);
  await setPaidDisplayFlash({
    tenantId: pending.tenant_id,
    branchId: pending.branch_id,
    orderId: pending._id,
    customerName: pending.customer_name,
    amount: pending.total,
    orderNumber: result.order.order_number,
  });

  return { ...result, already_fulfilled: false };
}

module.exports = {
  getOpenShift,
  requireOpenShift,
  completePosSale,
  recordShiftRefund,
  fulfillPosPaystackOrder,
};
