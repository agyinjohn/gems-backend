module.exports = {
  '/dashboard': {
    get: {
      tags: ['Dashboard'],
      summary: 'Get dashboard summary',
      responses: { 200: { description: 'Dashboard KPIs and recent activity' } },
    },
  },

  '/notifications': {
    get: {
      tags: ['Misc'],
      summary: 'Get in-app notifications (low stock, pending leave, unpaid orders, POs)',
      responses: { 200: { description: 'Array of notification objects' } },
    },
  },
};
