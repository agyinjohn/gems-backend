const mongoose = require('mongoose');
const {
  Order, Product, Expense, Employee, PayrollRun, LeaveRequest,
  PurchaseOrder, Customer, Lead, StockMovement, PosShift, Branch,
  JournalEntry,
} = require('../models');

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseObjectId(id) {
  if (!id) return null;
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

function parseDateRange(query) {
  const from = query.from ? new Date(query.from) : null;
  let to = query.to ? new Date(query.to) : null;
  if (to) to.setHours(23, 59, 59, 999);
  return { from, to };
}

function orderDateMatch(from, to) {
  if (!from && !to) return {};
  const m = {};
  if (from) m.$gte = from;
  if (to) m.$lte = to;
  return { createdAt: m };
}

function expenseDateMatch(from, to) {
  if (!from && !to) return {};
  const m = {};
  if (from) m.$gte = from;
  if (to) m.$lte = to;
  return { expense_date: m };
}

function poDateMatch(from, to) {
  if (!from && !to) return {};
  const m = {};
  if (from) m.$gte = from;
  if (to) m.$lte = to;
  return { createdAt: m };
}

function shiftDateMatch(from, to) {
  if (!from && !to) return {};
  const m = {};
  if (from) m.$gte = from;
  if (to) m.$lte = to;
  return { closed_at: m };
}

function branchFilter(branchId) {
  const id = parseObjectId(branchId);
  return id ? { branch_id: id } : {};
}

function previousPeriod(from, to) {
  if (!from || !to) return { prevFrom: null, prevTo: null };
  const ms = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  prevTo.setHours(23, 59, 59, 999);
  const prevFrom = new Date(prevTo.getTime() - ms);
  prevFrom.setHours(0, 0, 0, 0);
  return { prevFrom, prevTo };
}

function pctChange(current, previous) {
  const c = parseFloat(current) || 0;
  const p = parseFloat(previous) || 0;
  if (p === 0) return c === 0 ? 0 : 100;
  return Math.round(((c - p) / p) * 1000) / 10;
}

async function paidOrderStats(tenantId, from, to, branchId) {
  const match = {
    tenant_id: tenantId,
    payment_status: 'paid',
    ...orderDateMatch(from, to),
    ...branchFilter(branchId),
  };
  const [row] = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        revenue: { $sum: '$total' },
        subtotal: { $sum: '$subtotal' },
        tax: { $sum: '$tax_amount' },
        orders: { $sum: 1 },
        avg: { $avg: '$total' },
        refunds: { $sum: '$refund_amount' },
        discounts: { $sum: '$discount_amount' },
      },
    },
  ]);
  return row || { revenue: 0, subtotal: 0, tax: 0, orders: 0, avg: 0, refunds: 0, discounts: 0 };
}

function movementDateMatch(from, to) {
  if (!from && !to) {
    const fromDefault = new Date();
    fromDefault.setDate(fromDefault.getDate() - 29);
    fromDefault.setHours(0, 0, 0, 0);
    return { createdAt: { $gte: fromDefault } };
  }
  return orderDateMatch(from, to);
}

async function getGlSummary(tenantId, from, to) {
  const match = { tenant_id: tenantId, status: { $ne: 'voided' } };
  if (from || to) {
    match.entry_date = {};
    if (from) match.entry_date.$gte = from;
    if (to) match.entry_date.$lte = to;
  }

  const [entryCount, rows] = await Promise.all([
    JournalEntry.countDocuments(match),
    JournalEntry.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      { $lookup: { from: 'accounts', localField: 'lines.account_id', foreignField: '_id', as: 'acc' } },
      { $unwind: '$acc' },
      { $match: { 'acc.type': { $in: ['revenue', 'expense'] }, 'acc.is_group': { $ne: true } } },
      {
        $group: {
          _id: { type: '$acc.type', code: '$acc.code', name: '$acc.name' },
          debit: { $sum: '$lines.debit' },
          credit: { $sum: '$lines.credit' },
        },
      },
    ]),
  ]);

  if (!entryCount) {
    return { available: false, entry_count: 0 };
  }

  let revenue = 0;
  let cogs = 0;
  const expensesByCategory = [];

  for (const row of rows) {
    if (row._id.type === 'revenue') {
      revenue += row.credit - row.debit;
    } else if (row._id.code === '5001') {
      cogs += row.debit - row.credit;
    } else {
      const amt = row.debit - row.credit;
      if (amt > 0) expensesByCategory.push({ category: row._id.name, code: row._id.code, total: amt });
    }
  }

  const operatingExpenses = expensesByCategory.reduce((s, e) => s + e.total, 0);
  const totalExpenses = operatingExpenses + cogs;

  return {
    available: true,
    entry_count: entryCount,
    revenue,
    cogs,
    gross_profit: revenue - cogs,
    total_expenses: totalExpenses,
    net_profit: revenue - totalExpenses,
    expenses_by_category: expensesByCategory.sort((a, b) => b.total - a.total).slice(0, 8),
  };
}

async function getOverview(tenantId, query) {
  const { from, to } = parseDateRange(query);
  const branchId = query.branch_id;
  const { prevFrom, prevTo } = previousPeriod(from, to);

  const [
    sales, prevSales, lowStock, employees, pipeline, spend, shifts, coupons,
  ] = await Promise.all([
    paidOrderStats(tenantId, from, to, branchId),
    prevFrom ? paidOrderStats(tenantId, prevFrom, prevTo, branchId) : Promise.resolve(null),
    Product.countDocuments({
      tenant_id: tenantId,
      is_active: true,
      $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] },
      ...branchFilter(branchId),
    }),
    Employee.countDocuments({ tenant_id: tenantId, status: 'active' }),
    Lead.aggregate([
      { $match: { tenant_id: tenantId, stage: { $nin: ['won', 'lost'] } } },
      { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$value' } } },
    ]),
    PurchaseOrder.aggregate([
      { $match: { tenant_id: tenantId, ...poDateMatch(from, to), ...branchFilter(branchId) } },
      { $group: { _id: null, total: { $sum: '$total_cost' } } },
    ]),
    PosShift.aggregate([
      {
        $match: {
          tenant_id: tenantId,
          status: 'closed',
          ...shiftDateMatch(from, to),
          ...branchFilter(branchId),
        },
      },
      {
        $group: {
          _id: null,
          shifts: { $sum: 1 },
          sales_total: { $sum: '$sales_total' },
          variance: { $sum: '$cash_variance' },
        },
      },
    ]),
    Order.aggregate([
      {
        $match: {
          tenant_id: tenantId,
          payment_status: 'paid',
          coupon_code: { $exists: true, $nin: [null, ''] },
          ...orderDateMatch(from, to),
          ...branchFilter(branchId),
        },
      },
      { $group: { _id: null, orders: { $sum: 1 }, discount: { $sum: '$discount_amount' } } },
    ]),
  ]);

  const expMatch = { tenant_id: tenantId, ...expenseDateMatch(from, to) };
  const [expRow] = await Expense.aggregate([{ $match: expMatch }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
  const expenses = expRow?.total || 0;
  const netProfit = (sales.revenue || 0) - expenses;

  return {
    period: { from, to },
    revenue: sales.revenue || 0,
    revenue_change: prevSales ? pctChange(sales.revenue, prevSales.revenue) : null,
    orders: sales.orders || 0,
    orders_change: prevSales ? pctChange(sales.orders, prevSales.orders) : null,
    avg_order_value: sales.avg || 0,
    refunds: sales.refunds || 0,
    discounts: sales.discounts || 0,
    expenses,
    net_profit: netProfit,
    low_stock_items: lowStock,
    active_employees: employees,
    pipeline_leads: pipeline[0]?.count || 0,
    pipeline_value: pipeline[0]?.value || 0,
    procurement_spend: spend[0]?.total || 0,
    pos_shifts_closed: shifts[0]?.shifts || 0,
    pos_cash_variance: shifts[0]?.variance || 0,
    coupon_orders: coupons[0]?.orders || 0,
    coupon_discount_total: coupons[0]?.discount || 0,
  };
}

async function getSalesReport(tenantId, query) {
  const { from, to } = parseDateRange(query);
  const branchId = query.branch_id;
  const baseMatch = { tenant_id: tenantId, payment_status: 'paid', ...orderDateMatch(from, to), ...branchFilter(branchId) };
  const statusMatch = { tenant_id: tenantId, ...orderDateMatch(from, to), ...branchFilter(branchId) };

  const [summary, monthly, topProducts, bySource, byPayment, byStatus, refunds, byBranch, byCoupon] = await Promise.all([
    paidOrderStats(tenantId, from, to, branchId),
    Order.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          revenue: { $sum: '$total' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      {
        $project: {
          _id: 0,
          label: {
            $concat: [
              { $arrayElemAt: [MONTHS, '$_id.month'] },
              ' ',
              { $toString: '$_id.year' },
            ],
          },
          revenue: 1,
          orders: 1,
        },
      },
    ]),
    Order.aggregate([
      { $match: baseMatch },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product_id',
          name: { $first: '$items.product_name' },
          units_sold: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.total' },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
    ]),
    Order.aggregate([
      { $match: baseMatch },
      { $group: { _id: '$source', revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { revenue: -1 } },
    ]),
    Order.aggregate([
      { $match: baseMatch },
      { $group: { _id: '$payment_method', revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { revenue: -1 } },
    ]),
    Order.aggregate([{ $match: statusMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Order.aggregate([
      { $match: { ...statusMatch, refund_amount: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$refund_amount' }, count: { $sum: 1 } } },
    ]),
    branchId ? Promise.resolve([]) : Order.aggregate([
      { $match: { tenant_id: tenantId, payment_status: 'paid', ...orderDateMatch(from, to) } },
      { $lookup: { from: 'branches', localField: 'branch_id', foreignField: '_id', as: 'branch' } },
      {
        $group: {
          _id: { $ifNull: [{ $arrayElemAt: ['$branch.name', 0] }, 'Unassigned'] },
          revenue: { $sum: '$total' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
    ]),
    Order.aggregate([
      { $match: { ...baseMatch, coupon_code: { $exists: true, $nin: [null, ''] } } },
      {
        $group: {
          _id: '$coupon_code',
          orders: { $sum: 1 },
          discount: { $sum: '$discount_amount' },
          revenue: { $sum: '$total' },
        },
      },
      { $sort: { orders: -1 } },
      { $limit: 10 },
    ]),
  ]);

  const by_status = {};
  byStatus.forEach((r) => { by_status[r._id || 'unknown'] = r.count; });

  const shiftMatch = {
    tenant_id: tenantId,
    status: 'closed',
    ...branchFilter(branchId),
  };
  if (from || to) {
    Object.assign(shiftMatch, shiftDateMatch(from, to));
  }
  const posShifts = await PosShift.find(shiftMatch).sort({ closed_at: -1 }).limit(10).lean();

  return {
    period: { from, to },
    total_revenue: summary.revenue,
    total_orders: summary.orders,
    avg_order_value: summary.avg,
    subtotal: summary.subtotal,
    tax_total: summary.tax,
    paid_orders: summary.orders,
    refund_total: summary.refunds,
    discount_total: summary.discounts,
    refund_orders: refunds[0]?.count || 0,
    monthly,
    top_products: topProducts.map((p) => ({
      name: p.name,
      units_sold: p.units_sold,
      revenue: p.revenue,
    })),
    by_source: bySource.map((s) => ({ source: s._id || 'other', revenue: s.revenue, orders: s.orders })),
    by_payment: byPayment.map((p) => ({ method: p._id || 'unknown', revenue: p.revenue, orders: p.orders })),
    by_branch: byBranch.map((b) => ({ branch: b._id, revenue: b.revenue, orders: b.orders })),
    by_coupon: byCoupon.map((c) => ({
      code: c._id,
      orders: c.orders,
      discount: c.discount,
      revenue: c.revenue,
    })),
    by_status,
    recent_shifts: posShifts.map((s) => ({
      shift_number: s.shift_number,
      closed_at: s.closed_at,
      sales_total: s.sales_total,
      sales_count: s.sales_count,
      cash_variance: s.cash_variance,
    })),
  };
}

async function getInventoryReport(tenantId, query) {
  const { from, to } = parseDateRange(query);
  const branchId = query.branch_id;
  const productMatch = { tenant_id: tenantId, is_active: true, ...branchFilter(branchId) };

  const movementMatch = {
    tenant_id: tenantId,
    ...movementDateMatch(from, to),
    ...branchFilter(branchId),
  };

  const [products, valueAgg, lowStock, byCat, movements, stockTrend, topMoved] = await Promise.all([
    Product.find(productMatch),
    Product.aggregate([
      { $match: productMatch },
      { $group: { _id: null, total: { $sum: { $multiply: ['$cost_price', '$stock_qty'] } } } },
    ]),
    Product.find({ ...productMatch, $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] } })
      .sort('stock_qty')
      .limit(15)
      .select('name sku stock_qty low_stock_threshold cost_price price'),
    Product.aggregate([
      { $match: productMatch },
      { $lookup: { from: 'categories', localField: 'category_id', foreignField: '_id', as: 'cat' } },
      {
        $group: {
          _id: { $ifNull: [{ $arrayElemAt: ['$cat.name', 0] }, 'Uncategorized'] },
          value: { $sum: { $multiply: ['$cost_price', '$stock_qty'] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { value: -1 } },
    ]),
    StockMovement.aggregate([
      {
        $match: movementMatch,
      },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          qty: { $sum: { $abs: '$quantity' } },
        },
      },
      { $sort: { count: -1 } },
    ]),
    StockMovement.aggregate([
      { $match: movementMatch },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          in: { $sum: { $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 0] } },
          out: { $sum: { $cond: [{ $lt: ['$quantity', 0] }, { $abs: '$quantity' }, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 60 },
      { $project: { day: { $substr: ['$_id', 5, 5] }, in: 1, out: 1 } },
    ]),
    StockMovement.aggregate([
      { $match: movementMatch },
      { $group: { _id: '$product_id', moves: { $sum: 1 }, qty: { $sum: { $abs: '$quantity' } } } },
      { $sort: { qty: -1 } },
      { $limit: 8 },
      { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
      { $unwind: '$product' },
      { $project: { name: '$product.name', moves: 1, qty: 1 } },
    ]),
  ]);

  return {
    period: { from, to },
    total_products: products.length,
    out_of_stock: products.filter((p) => p.stock_qty === 0).length,
    low_stock_count: products.filter((p) => p.stock_qty <= p.low_stock_threshold && p.stock_qty > 0).length,
    total_value: valueAgg[0]?.total || 0,
    low_stock: lowStock,
    by_category: byCat.map((c) => ({ category: c._id, value: c.value, count: c.count })),
    movements_by_type: movements.map((m) => ({ type: m._id, count: m.count, qty: m.qty })),
    stock_trend: stockTrend,
    top_moved_products: topMoved.map((p) => ({ name: p.name, moves: p.moves, qty: p.qty })),
  };
}

async function getFinanceReport(tenantId, query) {
  const { from, to } = parseDateRange(query);
  const branchId = query.branch_id;

  const [sales, expAgg, byCat, glSummary] = await Promise.all([
    paidOrderStats(tenantId, from, to, branchId),
    Expense.aggregate([
      { $match: { tenant_id: tenantId, ...expenseDateMatch(from, to) } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Expense.aggregate([
      { $match: { tenant_id: tenantId, ...expenseDateMatch(from, to) } },
      { $group: { _id: { $ifNull: ['$category', 'Uncategorized'] }, total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
    ]),
    getGlSummary(tenantId, from, to),
  ]);

  const revenue = sales.revenue || 0;
  const total_expenses = expAgg[0]?.total || 0;

  return {
    period: { from, to },
    revenue,
    total_expenses,
    net_profit: revenue - total_expenses,
    refunds: sales.refunds || 0,
    note: 'Operational summary from orders and expenses. Use Accounting for GL-based statements.',
    expenses_by_category: byCat.map((c) => ({ category: c._id, total: c.total })),
    gl_summary: glSummary,
  };
}

async function getHrReport(tenantId, query) {
  const { from, to } = parseDateRange(query);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const payrollMatch = { tenant_id: tenantId, status: 'approved' };
  if (from || to) {
    payrollMatch.createdAt = orderDateMatch(from, to).createdAt;
  }

  const [employees, payroll, byDept, onLeave] = await Promise.all([
    Employee.find({ tenant_id: tenantId }),
    PayrollRun.aggregate([
      { $match: payrollMatch },
      { $group: { _id: null, total: { $sum: '$net_salary' }, runs: { $sum: 1 } } },
    ]),
    Employee.aggregate([
      { $match: { tenant_id: tenantId, status: 'active' } },
      { $lookup: { from: 'departments', localField: 'department_id', foreignField: '_id', as: 'dept' } },
      {
        $group: {
          _id: { $ifNull: [{ $arrayElemAt: ['$dept.name', 0] }, 'Unassigned'] },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]),
    LeaveRequest.countDocuments({
      tenant_id: tenantId,
      status: 'approved',
      start_date: { $lte: today },
      end_date: { $gte: today },
    }),
  ]);

  return {
    period: { from, to },
    total_employees: employees.length,
    active: employees.filter((e) => e.status === 'active').length,
    on_leave: onLeave,
    payroll_total: payroll[0]?.total || 0,
    payroll_runs: payroll[0]?.runs || 0,
    by_department: byDept.map((d) => ({ department: d._id, count: d.count })),
  };
}

async function getProcurementReport(tenantId, query) {
  const { from, to } = parseDateRange(query);
  const branchId = query.branch_id;
  const match = { tenant_id: tenantId, ...poDateMatch(from, to), ...branchFilter(branchId) };

  const [pos, spend, bySupplier, recent] = await Promise.all([
    PurchaseOrder.find(match),
    PurchaseOrder.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: '$total_cost' } } }]),
    PurchaseOrder.aggregate([
      { $match: match },
      { $lookup: { from: 'suppliers', localField: 'supplier_id', foreignField: '_id', as: 'sup' } },
      {
        $group: {
          _id: { $ifNull: [{ $arrayElemAt: ['$sup.name', 0] }, 'Unknown'] },
          total: { $sum: '$total_cost' },
        },
      },
      { $sort: { total: -1 } },
      { $limit: 10 },
    ]),
    PurchaseOrder.find(match).populate('supplier_id', 'name').sort({ createdAt: -1 }).limit(10),
  ]);

  return {
    period: { from, to },
    total_pos: pos.length,
    completed_pos: pos.filter((p) => p.status === 'completed').length,
    pending_delivery: pos.filter((p) => ['approved', 'sent', 'partially_received'].includes(p.status)).length,
    total_spend: spend[0]?.total || 0,
    by_supplier: bySupplier.map((s) => ({ supplier: s._id, total: s.total })),
    recent_pos: recent.map((p) => ({
      po_number: p.po_number,
      supplier_name: p.supplier_id?.name || '—',
      total_cost: p.total_cost,
      status: p.status,
      createdAt: p.createdAt,
    })),
  };
}

async function getCrmReport(tenantId, query) {
  const { from, to } = parseDateRange(query);
  const leadDate = from || to ? orderDateMatch(from, to) : {};
  const bf = branchFilter(query.branch_id);

  const [customers, leads, byStage, topBuyers] = await Promise.all([
    Customer.countDocuments({ tenant_id: tenantId, ...bf }),
    Lead.aggregate([
      { $match: { tenant_id: tenantId, ...bf, ...(leadDate.createdAt ? { createdAt: leadDate.createdAt } : {}) } },
      {
        $group: {
          _id: null,
          active: { $sum: { $cond: [{ $not: [{ $in: ['$stage', ['won', 'lost']] }] }, 1, 0] } },
          won: { $sum: { $cond: [{ $eq: ['$stage', 'won'] }, 1, 0] } },
          pipeline: { $sum: { $cond: [{ $not: [{ $in: ['$stage', ['won', 'lost']] }] }, '$value', 0] } },
        },
      },
    ]),
    Lead.aggregate([
      { $match: { tenant_id: tenantId, ...bf } },
      { $group: { _id: '$stage', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Order.aggregate([
      {
        $match: {
          tenant_id: tenantId,
          payment_status: 'paid',
          ...orderDateMatch(from, to),
        },
      },
      {
        $group: {
          _id: { email: { $toLower: { $ifNull: ['$customer_email', ''] } }, name: '$customer_name' },
          order_count: { $sum: 1 },
          revenue: { $sum: '$total' },
        },
      },
      { $match: { '_id.email': { $ne: '' } } },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
    ]),
  ]);

  const l = leads[0] || {};
  return {
    period: { from, to },
    total_customers: customers,
    active_leads: l.active || 0,
    won_leads: l.won || 0,
    pipeline_value: l.pipeline || 0,
    by_stage: byStage.map((s) => ({ stage: s._id, count: s.count })),
    top_customers: topBuyers.map((c) => ({
      name: c._id.name || 'Customer',
      email: c._id.email,
      order_count: c.order_count,
      revenue: c.revenue,
    })),
  };
}

async function listReportBranches(tenantId) {
  return Branch.find({ tenant_id: tenantId, is_active: true }).select('name code').sort('name');
}

module.exports = {
  getOverview,
  getSalesReport,
  getInventoryReport,
  getFinanceReport,
  getHrReport,
  getProcurementReport,
  getCrmReport,
  listReportBranches,
};
