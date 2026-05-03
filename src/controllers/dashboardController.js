const { Order, Product, Customer, Lead, Employee, Expense, PurchaseOrder, Attendance, LeaveRequest, PayrollRun, StockMovement, Supplier } = require('../models');

const getDashboard = async (req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const tid = req.tenant_id;
  const role = req.user?.role;

  // ── SALES STAFF ──────────────────────────────────────────────────────────────────
  if (role === 'sales_staff') {
    const [todayOrders, monthRevenue, activeLeads, recentOrders, topProducts, monthlySales] = await Promise.all([
      Order.countDocuments({ tenant_id: tid, createdAt: { $gte: new Date(new Date().setHours(0,0,0,0)) } }),
      Order.aggregate([{ $match: { tenant_id: tid, payment_status: 'paid', createdAt: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Lead.countDocuments({ tenant_id: tid, stage: { $nin: ['won','lost'] } }),
      Order.find({ tenant_id: tid }).sort({ createdAt: -1 }).limit(8).select('order_number customer_name total status payment_status createdAt'),
      Order.aggregate([
        { $match: { tenant_id: tid, payment_status: 'paid' } },
        { $unwind: '$items' },
        { $group: { _id: '$items.product_id', name: { $first: '$items.product_name' }, units_sold: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' } } },
        { $sort: { revenue: -1 } }, { $limit: 5 },
      ]),
      Order.aggregate([
        { $match: { tenant_id: tid, payment_status: 'paid', createdAt: { $gte: new Date(Date.now() - 6*30*24*60*60*1000) } } },
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
    const [totalProducts, lowStock, outOfStock, recentMovements, lowStockItems] = await Promise.all([
      Product.countDocuments({ tenant_id: tid, is_active: true }),
      Product.countDocuments({ tenant_id: tid, is_active: true, $expr: { $and: [{ $lte: ['$stock_qty', '$low_stock_threshold'] }, { $gt: ['$stock_qty', 0] }] } }),
      Product.countDocuments({ tenant_id: tid, is_active: true, stock_qty: 0 }),
      StockMovement.find({ tenant_id: tid }).sort({ createdAt: -1 }).limit(10).populate('product_id', 'name'),
      Product.find({ tenant_id: tid, is_active: true, $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] } }).sort('stock_qty').limit(8).select('name stock_qty low_stock_threshold sku'),
    ]);
    return res.json({ success: true, data: {
      role: 'warehouse_staff',
      kpis: { total_products: totalProducts, low_stock: lowStock, out_of_stock: outOfStock },
      recent_movements: recentMovements.map(m => ({ ...m.toJSON(), product_name: m.product_id?.name || 'Unknown' })),
      low_stock_items: lowStockItems,
    }});
  }

  // ── ACCOUNTANT ─────────────────────────────────────────────────────────────────────
  if (role === 'accountant') {
    const [revenue, cogs, monthExpenses, totalExpenses, recentExpenses, monthlyRevenue, expByCategory] = await Promise.all([
      Order.aggregate([{ $match: { tenant_id: tid, payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' }, subtotal: { $sum: '$subtotal' } } }]),
      Order.aggregate([{ $match: { tenant_id: tid, payment_status: 'paid' } }, { $group: { _id: null, cogs: { $sum: '$subtotal' } } }]),
      Expense.aggregate([{ $match: { tenant_id: tid, expense_date: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Expense.aggregate([{ $match: { tenant_id: tid } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
      Expense.find({ tenant_id: tid }).sort({ expense_date: -1 }).limit(8).select('title category amount expense_date'),
      Order.aggregate([
        { $match: { tenant_id: tid, payment_status: 'paid', createdAt: { $gte: new Date(Date.now() - 6*30*24*60*60*1000) } } },
        { $group: { _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } }, revenue: { $sum: '$total' } } },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
        { $project: { month: { $arrayElemAt: [['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], '$_id.month'] }, revenue: 1 } },
      ]),
      Expense.aggregate([{ $match: { tenant_id: tid } }, { $group: { _id: { $ifNull: ['$category','Uncategorized'] }, total: { $sum: '$amount' } } }, { $sort: { total: -1 } }, { $limit: 6 }]),
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
    const today = new Date(); today.setHours(0,0,0,0);
    const [totalEmp, onLeave, todayAttendance, pendingLeave, recentLeave, monthPayroll] = await Promise.all([
      Employee.countDocuments({ tenant_id: tid, status: 'active' }),
      Employee.countDocuments({ tenant_id: tid, status: 'on_leave' }),
      Attendance.countDocuments({ tenant_id: tid, date: { $gte: today }, status: 'present' }),
      LeaveRequest.countDocuments({ tenant_id: tid, status: 'pending' }),
      LeaveRequest.find({ tenant_id: tid }).sort({ createdAt: -1 }).limit(8).populate('employee_id', 'name'),
      PayrollRun.aggregate([{ $match: { tenant_id: tid, month: today.getMonth()+1, year: today.getFullYear(), status: 'approved' } }, { $group: { _id: null, total: { $sum: '$net_salary' } } }]),
    ]);
    return res.json({ success: true, data: {
      role: 'hr_manager',
      kpis: { total_employees: totalEmp, on_leave: onLeave, present_today: todayAttendance, pending_leave: pendingLeave, month_payroll: monthPayroll[0]?.total || 0 },
      recent_leave: recentLeave.map(l => ({ ...l.toJSON(), employee_name: l.employee_id?.name || 'Unknown' })),
    }});
  }

  // ── PROCUREMENT OFFICER ──────────────────────────────────────────────────────────
  if (role === 'procurement_officer') {
    const [totalPOs, pendingPOs, totalSuppliers, totalSpend, recentPOs] = await Promise.all([
      PurchaseOrder.countDocuments({ tenant_id: tid }),
      PurchaseOrder.countDocuments({ tenant_id: tid, status: { $in: ['draft','pending_approval','approved','sent'] } }),
      Supplier.countDocuments({ tenant_id: tid, is_active: true }),
      PurchaseOrder.aggregate([{ $match: { tenant_id: tid, status: 'completed' } }, { $group: { _id: null, total: { $sum: '$total_cost' } } }]),
      PurchaseOrder.find({ tenant_id: tid }).sort({ createdAt: -1 }).limit(8).populate('supplier_id', 'name').select('po_number status total_cost expected_date createdAt supplier_id'),
    ]);
    return res.json({ success: true, data: {
      role: 'procurement_officer',
      kpis: { total_pos: totalPOs, pending_pos: pendingPOs, total_suppliers: totalSuppliers, total_spend: totalSpend[0]?.total || 0 },
      recent_pos: recentPOs.map(p => ({ ...p.toJSON(), supplier_name: p.supplier_id?.name || 'Unknown' })),
    }});
  }

  // ── SUPER ADMIN / BUSINESS OWNER / BRANCH MANAGER (full dashboard) ─────────────────────
  const [orders, revenue, products, lowStock, customers, leads, employees, expenses, recentOrders, topProducts, monthlySales] = await Promise.all([
    Order.countDocuments({ tenant_id: tid, payment_status: 'paid' }),
    Order.aggregate([{ $match: { tenant_id: tid, payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Product.countDocuments({ tenant_id: tid, is_active: true }),
    Product.countDocuments({ tenant_id: tid, $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] }, is_active: true }),
    Customer.countDocuments({ tenant_id: tid }),
    Lead.countDocuments({ tenant_id: tid, stage: { $nin: ['won', 'lost'] } }),
    Employee.countDocuments({ tenant_id: tid, status: 'active' }),
    Expense.aggregate([{ $match: { tenant_id: tid, expense_date: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Order.find({ tenant_id: tid }).sort({ createdAt: -1 }).limit(5).select('order_number customer_name total status payment_status createdAt'),
    Order.aggregate([
      { $match: { tenant_id: tid, payment_status: 'paid' } },
      { $unwind: '$items' },
      { $group: { _id: '$items.product_id', name: { $first: '$items.product_name' }, units_sold: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' } } },
      { $sort: { revenue: -1 } }, { $limit: 5 },
    ]),
    Order.aggregate([
      { $match: { tenant_id: tid, payment_status: 'paid', createdAt: { $gte: new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000) } } },
      { $group: { _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      { $project: { month: { $arrayElemAt: [['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], '$_id.month'] }, revenue: 1, orders: 1 } },
    ]),
  ]);

  res.json({
    success: true,
    data: {
      role: 'admin',
      kpis: {
        total_orders: orders,
        total_revenue: revenue[0]?.total || 0,
        total_products: products,
        low_stock_items: lowStock,
        total_customers: customers,
        active_leads: leads,
        total_employees: employees,
        monthly_expenses: expenses[0]?.total || 0,
      },
      recent_orders: recentOrders,
      top_products: topProducts,
      monthly_sales: monthlySales,
    },
  });
};

module.exports = { getDashboard };
