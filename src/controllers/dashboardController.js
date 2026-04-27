const { Order, Product, Customer, Lead, Employee, Expense } = require('../models');

const getDashboard = async (req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [orders, revenue, products, lowStock, customers, leads, employees, expenses, recentOrders, topProducts, monthlySales] = await Promise.all([
    Order.countDocuments({ payment_status: 'paid' }),
    Order.aggregate([{ $match: { payment_status: 'paid' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
    Product.countDocuments({ is_active: true }),
    Product.countDocuments({ $expr: { $lte: ['$stock_qty', '$low_stock_threshold'] }, is_active: true }),
    Customer.countDocuments(),
    Lead.countDocuments({ stage: { $nin: ['won', 'lost'] } }),
    Employee.countDocuments({ status: 'active' }),
    Expense.aggregate([{ $match: { expense_date: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Order.find().sort({ createdAt: -1 }).limit(5).select('order_number customer_name total status payment_status createdAt'),
    Order.aggregate([
      { $match: { payment_status: 'paid' } },
      { $unwind: '$items' },
      { $group: { _id: '$items.product_id', name: { $first: '$items.product_name' }, units_sold: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' } } },
      { $sort: { revenue: -1 } }, { $limit: 5 },
    ]),
    Order.aggregate([
      { $match: { payment_status: 'paid', createdAt: { $gte: new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000) } } },
      { $group: { _id: { month: { $month: '$createdAt' }, year: { $year: '$createdAt' } }, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
      { $project: { month: { $arrayElemAt: [['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], '$_id.month'] }, revenue: 1, orders: 1 } },
    ]),
  ]);

  res.json({
    success: true,
    data: {
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
