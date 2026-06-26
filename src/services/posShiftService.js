const { PosShift, Order } = require('../models');

function displayCashierName(shift) {
  if (shift.cashier_name) return shift.cashier_name;
  if (shift.opened_by?.name) return shift.opened_by.name;
  return null;
}

function buildZReport(shift) {
  const openingFloat = shift.opening_float || 0;
  const expectedCash = shift.expected_cash ?? openingFloat;
  const cashSales = Math.max(0, expectedCash - openingFloat);
  return {
    shift_number: shift.shift_number,
    cashier_name: displayCashierName(shift),
    opened_at: shift.opened_at,
    closed_at: shift.closed_at,
    opening_float: openingFloat,
    sales_count: shift.sales_count || 0,
    sales_total: shift.sales_total || 0,
    refunds_total: shift.refunds_total || 0,
    cash_sales: cashSales,
    card_total: shift.card_total || 0,
    momo_total: shift.momo_total || 0,
    expected_cash: expectedCash,
    actual_cash: shift.actual_cash,
    cash_variance: shift.cash_variance,
    status: shift.status,
    notes: shift.notes || '',
  };
}

function shiftListFilter(tenantId, user, query = {}) {
  const filter = { tenant_id: tenantId };
  const { from, to, status = 'all' } = query;

  if (status && status !== 'all') filter.status = status;
  if (user.role === 'sales_staff') filter.opened_by = user._id;

  if (from || to) {
    filter.opened_at = {};
    if (from) filter.opened_at.$gte = new Date(from);
    if (to) filter.opened_at.$lte = new Date(`${to}T23:59:59.999`);
  }

  return filter;
}

async function listShifts(tenantId, user, query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const filter = shiftListFilter(tenantId, user, query);

  const [shifts, total] = await Promise.all([
    PosShift.find(filter)
      .sort({ opened_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('opened_by', 'name email')
      .populate('closed_by', 'name email')
      .populate('branch_id', 'name')
      .lean(),
    PosShift.countDocuments(filter),
  ]);

  return {
    shifts: shifts.map((s) => ({
      id: s._id,
      shift_number: s.shift_number,
      status: s.status,
      opened_at: s.opened_at,
      closed_at: s.closed_at,
      opening_float: s.opening_float,
      sales_count: s.sales_count,
      sales_total: s.sales_total,
      refunds_total: s.refunds_total,
      card_total: s.card_total,
      momo_total: s.momo_total,
      cash_variance: s.cash_variance,
      notes: s.notes,
      cashier_name: displayCashierName(s),
      opened_by: s.opened_by ? { id: s.opened_by._id, name: s.opened_by.name, email: s.opened_by.email } : null,
      closed_by: s.closed_by ? { id: s.closed_by._id, name: s.closed_by.name, email: s.closed_by.email } : null,
      branch: s.branch_id ? { id: s.branch_id._id, name: s.branch_id.name } : null,
    })),
    total,
    page,
    pages: Math.ceil(total / limit) || 1,
  };
}

function aggregateShiftOrders(orders) {
  const productMap = new Map();
  const refunds = [];
  const paymentMap = new Map();

  for (const order of orders) {
    const method = order.payment_method || 'unknown';
    if (!paymentMap.has(method)) {
      paymentMap.set(method, { method, orders: 0, gross_total: 0, refund_total: 0 });
    }
    const pay = paymentMap.get(method);
    pay.orders += 1;
    pay.gross_total += order.subtotal || order.total || 0;
    pay.refund_total += order.refund_amount || 0;

    for (const item of order.items || []) {
      const soldQty = item.quantity || 0;
      const refundedQty = item.refunded_qty || 0;
      const key = String(item.product_id || item.product_name);

      if (!productMap.has(key)) {
        productMap.set(key, {
          product_id: item.product_id,
          product_name: item.product_name,
          quantity_sold: 0,
          quantity_refunded: 0,
          gross_revenue: 0,
          refund_amount: 0,
          net_revenue: 0,
        });
      }

      const row = productMap.get(key);
      row.quantity_sold += soldQty;
      row.quantity_refunded += refundedQty;
      row.gross_revenue += item.unit_price * soldQty;
      row.refund_amount += item.unit_price * refundedQty;
      row.net_revenue += item.unit_price * (soldQty - refundedQty);
    }

    if ((order.refund_amount || 0) > 0) {
      refunds.push({
        order_id: order._id,
        order_number: order.order_number,
        payment_method: order.payment_method,
        refund_amount: order.refund_amount,
        items: (order.items || [])
          .filter((i) => (i.refunded_qty || 0) > 0)
          .map((i) => ({
            product_name: i.product_name,
            quantity: i.refunded_qty,
            unit_price: i.unit_price,
            amount: i.unit_price * i.refunded_qty,
          })),
      });
    }
  }

  const grossSales = orders.reduce((sum, o) => sum + (o.subtotal || o.total || 0), 0);
  const totalRefunds = orders.reduce((sum, o) => sum + (o.refund_amount || 0), 0);

  return {
    products: Array.from(productMap.values()).sort((a, b) => b.net_revenue - a.net_revenue),
    refunds,
    payment_breakdown: Array.from(paymentMap.values()).sort((a, b) => b.gross_total - a.gross_total),
    gross_sales: grossSales,
    net_sales: grossSales - totalRefunds,
    total_refunds: totalRefunds,
  };
}

async function getShiftDetail(tenantId, user, shiftId) {
  const filter = { _id: shiftId, tenant_id: tenantId };
  if (user.role === 'sales_staff') filter.opened_by = user._id;

  const shift = await PosShift.findOne(filter)
    .populate('opened_by', 'name email')
    .populate('closed_by', 'name email')
    .populate('branch_id', 'name')
    .lean();

  if (!shift) return null;

  const orders = await Order.find({
    tenant_id: tenantId,
    shift_id: shiftId,
    source: 'pos',
    payment_status: { $in: ['paid', 'refunded'] },
  })
    .sort({ createdAt: 1 })
    .lean();

  const aggregated = aggregateShiftOrders(orders);

  return {
    shift: {
      id: shift._id,
      shift_number: shift.shift_number,
      status: shift.status,
      opened_at: shift.opened_at,
      closed_at: shift.closed_at,
      opening_float: shift.opening_float,
      expected_cash: shift.expected_cash,
      actual_cash: shift.actual_cash,
      cash_variance: shift.cash_variance,
      sales_count: shift.sales_count,
      sales_total: shift.sales_total,
      refunds_total: shift.refunds_total,
      card_total: shift.card_total,
      momo_total: shift.momo_total,
      notes: shift.notes,
      cashier_name: displayCashierName(shift),
      opened_by: shift.opened_by ? { id: shift.opened_by._id, name: shift.opened_by.name, email: shift.opened_by.email } : null,
      closed_by: shift.closed_by ? { id: shift.closed_by._id, name: shift.closed_by.name, email: shift.closed_by.email } : null,
      branch: shift.branch_id ? { id: shift.branch_id._id, name: shift.branch_id.name } : null,
    },
    z_report: buildZReport(shift),
    summary: {
      order_count: orders.length,
      gross_sales: aggregated.gross_sales,
      net_sales: aggregated.net_sales,
      total_refunds: aggregated.total_refunds,
      product_lines: aggregated.products.length,
      refund_count: aggregated.refunds.length,
    },
    products: aggregated.products,
    orders: orders.map((o) => ({
      id: o._id,
      order_number: o.order_number,
      created_at: o.createdAt,
      customer_name: o.customer_name,
      payment_method: o.payment_method,
      subtotal: o.subtotal || o.total,
      refund_amount: o.refund_amount || 0,
      payment_status: o.payment_status,
      items: (o.items || []).map((i) => ({
        product_name: i.product_name,
        quantity: i.quantity,
        refunded_qty: i.refunded_qty || 0,
        unit_price: i.unit_price,
        total: i.total,
      })),
    })),
    refunds: aggregated.refunds,
    payment_breakdown: aggregated.payment_breakdown,
  };
}

module.exports = {
  buildZReport,
  listShifts,
  getShiftDetail,
};
