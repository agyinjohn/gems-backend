const { Order, Product, Customer, Lead, Employee, Expense, PurchaseOrder, Attendance, LeaveRequest, PayrollRun, StockMovement, Supplier } = require('../models');

const getDashboard = async (req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const tid = req.tenant_id;
  const role = req.user?.role;
  // Branch scope — pinned for branch-level users, chosen/all for org-level.
  // Only merged into queries on collections that carry branch_id (Order,
  // Product, StockMovement, PurchaseOrder, Expense, Employee). Collections
  // without branch_id (Customer, Lead, Attendance, LeaveRequest, PayrollRun,
  // Supplier) stay tenant-scoped.
  const bf = req.branchFilter || {};

  // ── SALES STAFF ──────────────────────────────────────────────────────────────────
  if (role === 'sales_staff') {
    const [todayOrders, monthRevenue, activeLeads, recentOrders, topProducts, monthlySales] = await Promise.all([
      Order.countDocuments({ tenant_id: tid, ...bf, createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) } }),
      Order.aggregate([{ $match: { tenant_id: tid, ...bf, payment_status: 'paid', createdAt: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Lead.countDocuments({ tenant_id: tid, ...bf, stage: { $nin: ['won','lost'] } }),
      Order.find({ tenant_id: tid, ...bf }).sort({ createdAt: -1 }).limit(8).select('order_number customer_name total status payment_status createdAt'),
      Order.aggregate([
        { $match: { tenant_id: tid, ...bf, payment_status: 'paid' } },
        { $unwind: '$items' },
        { $group: { _id: '$items.product_id', name: { $first: '$items.product_name' }, units_sold: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' } } },
        { $sort: { revenue: -1 } }, { $limit: 5 },
      ]),
      Order.aggregate([
        { $match: { tenant_id: tid, ...bf, payment_status: 'paid', createdAt: { $gte: new Date(Date.now() - 6*30*24*60*60*1000) } } },
        { $group: { _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
        { $project: { month: { $arrayElemAt: [['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], '$_id.month'] }, revenue: 1, orders: 1 } },
      ]),
    ]);
    return res.json({ success: true, data: {
      role: 'sales_staff',
      kpis: { today_orders: todayOrders, month_revenue: monthRevenue[0]?.total || 0, active_leads: activeLeads },
      recent_orders: recentOrders, top_products: topProducts, monthly_sales: monthlySales,
    }});
  }

  // ── WAREHOUSE STAFF ──────────────────────────────────────────────────────────
  if (role === 'warehouse_staff') {
    const weekAgo  = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [
      totalProducts, lowStock, outOfStock, healthyStock,
      recentMovements, lowStockItems,
      totalStockValue, movementsByType, stockTrend, topMovedProducts, pendingPOs,
    ] = await Promise.all([
      Product.countDocuments({ tenant_id: tid, ...bf, is_active: true }),
      Product.countDocuments({ tenant_id: tid, ...bf, is_active: true, $expr: { $and: [{ $lte: ['$stock_qty', '$low_stock_threshold'] }, { $gt: ['$stock_qty', 0] }] } }),
      Product.countDocuments({ tenant_id: tid, ...bf, is_active: true, stock_qty: 0 }),
      Product.countDocuments({ tenant_id: tid, ...bf, is_active: true, $expr: { $gt: ['$stock_qty', '$low_stock_threshold'] } }),
      StockMovement.find({ tenant_id: tid, ...bf }).sort({ createdAt: -1 }).limit(12).populate('product_id', 'name'),
      Product.find({ tenant_id: tid, ...bf, is_active: true, $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] } }).sort('stock_qty').limit(10).select('name stock_qty low_stock_threshold sku cost_price'),
      // Total inventory value
      Product.aggregate([{ $match: { tenant_id: tid, ...bf, is_active: true } }, { $group: { _id: null, value: { $sum: { $multiply: ['$cost_price', '$stock_qty'] } } } }]),
      // Movement breakdown by type — last 30 days
      StockMovement.aggregate([
        { $match: { tenant_id: tid, ...bf, createdAt: { $gte: monthAgo } } },
        { $group: { _id: '$type', count: { $sum: 1 }, qty: { $sum: { $abs: '$quantity' } } } },
      ]),
      // Daily in/out trend — last 7 days
      StockMovement.aggregate([
        { $match: { tenant_id: tid, ...bf, createdAt: { $gte: weekAgo } } },
        { $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          in:  { $sum: { $cond: [{ $gt: ['$quantity', 0] }, '$quantity', 0] } },
          out: { $sum: { $cond: [{ $lt: ['$quantity', 0] }, { $abs: '$quantity' }, 0] } },
        }},
        { $sort: { _id: 1 } },
        { $project: { day: { $substr: ['$_id', 5, 5] }, in: 1, out: 1 } },
      ]),
      // Top 5 most moved products — last 30 days
      StockMovement.aggregate([
        { $match: { tenant_id: tid, ...bf, createdAt: { $gte: monthAgo } } },
        { $group: { _id: '$product_id', moves: { $sum: 1 }, qty: { $sum: { $abs: '$quantity' } } } },
        { $sort: { qty: -1 } }, { $limit: 5 },
        { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
        { $unwind: '$product' },
        { $project: { name: '$product.name', stock_qty: '$product.stock_qty', moves: 1, qty: 1 } },
      ]),
      // Pending POs awaiting goods receipt
      PurchaseOrder.countDocuments({ tenant_id: tid, ...bf, status: { $in: ['approved', 'sent', 'partially_received'] } }),
    ]);

    return res.json({ success: true, data: {
      role: 'warehouse_staff',
      kpis: {
        total_products: totalProducts,
        low_stock:      lowStock,
        out_of_stock:   outOfStock,
        healthy_stock:  healthyStock,
        stock_value:    totalStockValue[0]?.value || 0,
        pending_pos:    pendingPOs,
      },
      recent_movements:   recentMovements.map(m => ({ ...m.toJSON(), product_name: m.product_id?.name || 'Unknown' })),
      low_stock_items:    lowStockItems,
      movements_by_type:  movementsByType,
      stock_trend:        stockTrend,
      top_moved_products: topMovedProducts,
    }});
  }

  // ── ACCOUNTANT ─────────────────────────────────────────────────────────────────────
  if (role === 'accountant') {
    const [revenue, cogs, monthExpenses, totalExpenses, recentExpenses, monthlyRevenue, expByCategory] = await Promise.all([
      Order.aggregate([{ $match: { tenant_id: tid, ...bf, payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' }, subtotal: { $sum: '$subtotal' } } }]),
      Order.aggregate([{ $match: { tenant_id: tid, ...bf, payment_status: 'paid' } }, { $group: { _id: null, cogs: { $sum: '$subtotal' } } }]),
      Expense.aggregate([{ $match: { tenant_id: tid, ...bf, expense_date: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Expense.aggregate([{ $match: { tenant_id: tid, ...bf } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Expense.find({ tenant_id: tid, ...bf }).sort({ expense_date: -1 }).limit(8).select('title category amount expense_date'),
      Order.aggregate([
        { $match: { tenant_id: tid, ...bf, payment_status: 'paid', createdAt: { $gte: new Date(Date.now() - 6*30*24*60*60*1000) } } },
        { $group: { _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } }, revenue: { $sum: '$total' } } },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
        { $project: { month: { $arrayElemAt: [['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], '$_id.month'] }, revenue: 1 } },
      ]),
      Expense.aggregate([{ $match: { tenant_id: tid, ...bf } }, { $group: { _id: { $ifNull: ['$category','Uncategorized'] }, total: { $sum: '$amount' } } }, { $sort: { total: -1 } }, { $limit: 6 }]),
    ]);
    const totalRev = revenue[0]?.total || 0;
    const totalExp = totalExpenses[0]?.total || 0;
    return res.json({ success: true, data: {
      role: 'accountant',
      kpis: { total_revenue: totalRev, total_expenses: totalExp, net_profit: totalRev - totalExp, month_expenses: monthExpenses[0]?.total || 0 },
      recent_expenses: recentExpenses,
      monthly_revenue: monthlyRevenue,
      expenses_by_category: expByCategory.map(e => ({ category: e._id, total: e.total })),
    }});
  }

  // ── HR MANAGER ──────────────────────────────────────────────────────────────────────
  if (role === 'hr_manager') {
    const hrService = require('../services/hrService');
    const today = new Date(); today.setHours(0,0,0,0);
    const [recentLeave, monthPayroll, hrSummary] = await Promise.all([
      LeaveRequest.find({ tenant_id: tid, ...bf }).sort({ createdAt: -1 }).limit(8).populate('employee_id', 'name'),
      PayrollRun.aggregate([{ $match: { tenant_id: tid, ...bf, month: today.getMonth()+1, year: today.getFullYear(), status: 'approved' } }, { $group: { _id: null, total: { $sum: '$net_salary' } } }]),
      hrService.getHrSummary(tid, {}, bf),
    ]);
    return res.json({ success: true, data: {
      role: 'hr_manager',
      // NOTE: on_leave/pending_leave/present_today now come from hrService.getHrSummary,
      // which derives on_leave from actual LeaveRequest overlap — the previous
      // Employee.countDocuments({status:'on_leave'}) always returned 0 since nothing
      // in the app ever sets that status value.
      kpis: {
        total_employees: hrSummary.active,
        on_leave: hrSummary.on_leave,
        present_today: hrSummary.attendance_today,
        pending_leave: hrSummary.pending_leave,
        month_payroll: monthPayroll[0]?.total || 0,
      },
      recent_leave: recentLeave.map(l => ({ ...l.toJSON(), employee_name: l.employee_id?.name || 'Unknown' })),
      department_breakdown: hrSummary.department_breakdown,
      employment_type_breakdown: hrSummary.employment_type_breakdown,
      payroll_trend: hrSummary.payroll_trend,
      outstanding_loans_total: hrSummary.outstanding_loans_total,
      outstanding_loans_count: hrSummary.outstanding_loans_count,
      upcoming_birthdays: hrSummary.upcoming_birthdays,
      upcoming_anniversaries: hrSummary.upcoming_anniversaries,
    }});
  }

  // ── PROCUREMENT OFFICER ──────────────────────────────────────────────────────────
  if (role === 'procurement_officer') {
    const [totalPOs, pendingPOs, totalSuppliers, totalSpend, recentPOs] = await Promise.all([
      PurchaseOrder.countDocuments({ tenant_id: tid, ...bf }),
      PurchaseOrder.countDocuments({ tenant_id: tid, ...bf, status: { $in: ['draft','pending_approval','approved','sent'] } }),
      Supplier.countDocuments({ tenant_id: tid, is_active: true }),
      PurchaseOrder.aggregate([{ $match: { tenant_id: tid, ...bf, status: 'completed' } }, { $group: { _id: null, total: { $sum: '$total_cost' } } }]),
      PurchaseOrder.find({ tenant_id: tid, ...bf }).sort({ createdAt: -1 }).limit(8).populate('supplier_id', 'name').select('po_number status total_cost expected_date createdAt supplier_id'),
    ]);
    return res.json({ success: true, data: {
      role: 'procurement_officer',
      kpis: { total_pos: totalPOs, pending_pos: pendingPOs, total_suppliers: totalSuppliers, total_spend: totalSpend[0]?.total || 0 },
      recent_pos: recentPOs.map(p => ({ ...p.toJSON(), supplier_name: p.supplier_id?.name || 'Unknown' })),
    }});
  }

  // ── SUPER ADMIN / BUSINESS OWNER / BRANCH MANAGER ────────────────────────────────
  const [orders, revenue, products, lowStock, customers, leads, employees, expenses, recentOrders, topProducts, monthlySales] = await Promise.all([
    Order.countDocuments({ tenant_id: tid, ...bf, payment_status: 'paid' }),
    Order.aggregate([{ $match: { tenant_id: tid, ...bf, payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Product.countDocuments({ tenant_id: tid, ...bf, is_active: true }),
    Product.countDocuments({ tenant_id: tid, ...bf, $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] }, is_active: true }),
    Customer.countDocuments({ tenant_id: tid, ...bf }),
    Lead.countDocuments({ tenant_id: tid, ...bf, stage: { $nin: ['won', 'lost'] } }),
    Employee.countDocuments({ tenant_id: tid, ...bf, status: 'active' }),
    Expense.aggregate([{ $match: { tenant_id: tid, ...bf, expense_date: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Order.find({ tenant_id: tid, ...bf }).sort({ createdAt: -1 }).limit(5).select('order_number customer_name total status payment_status createdAt'),
    Order.aggregate([
      { $match: { tenant_id: tid, ...bf, payment_status: 'paid' } },
      { $unwind: '$items' },
      { $group: { _id: '$items.product_id', name: { $first: '$items.product_name' }, units_sold: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' } } },
      { $sort: { revenue: -1 } }, { $limit: 5 },
    ]),
    Order.aggregate([
      { $match: { tenant_id: tid, ...bf, payment_status: 'paid', createdAt: { $gte: new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000) } } },
      { $group: { _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      { $project: { month: { $arrayElemAt: [['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], '$_id.month'] }, revenue: 1, orders: 1 } },
    ]),
  ]);

  res.json({ success: true, data: {
    role: 'admin',
    kpis: {
      total_orders: orders, total_revenue: revenue[0]?.total || 0,
      total_products: products, low_stock_items: lowStock,
      total_customers: customers, active_leads: leads,
      total_employees: employees, monthly_expenses: expenses[0]?.total || 0,
    },
    recent_orders: recentOrders, top_products: topProducts, monthly_sales: monthlySales,
  }});
};

module.exports = { getDashboard };
