const express = require('express');
const router = express.Router();

/** Public headless storefront API reference */
router.get('/storefront/docs', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}/api`;
  res.json({
    success: true,
    data: {
      title: 'GEMS Storefront API',
      version: '1.0',
      base_url: base,
      authentication: 'Public endpoints — no auth required unless noted.',
      endpoints: [
        { method: 'GET', path: '/storefront/:tenantSlug/branches', description: 'Store info and branch list' },
        { method: 'GET', path: '/storefront/:tenantSlug/settings', description: 'Public store settings (delivery, tax, min order)' },
        { method: 'GET', path: '/storefront/products?tenant_slug=&branch_slug=&search=&page=&limit=', description: 'Paginated product catalog' },
        { method: 'GET', path: '/storefront/categories?tenant_slug=', description: 'Product categories' },
        { method: 'GET', path: '/storefront/cart/:cartId', description: 'Get server-side cart' },
        { method: 'POST', path: '/storefront/cart/add', body: '{ cart_id?, product_id, quantity, tenant_id? }', description: 'Add item to cart' },
        { method: 'PATCH', path: '/storefront/cart/update', body: '{ cart_id, product_id, quantity }', description: 'Update line quantity (0 removes)' },
        { method: 'DELETE', path: '/storefront/cart/:cartId', description: 'Clear cart' },
        { method: 'POST', path: '/storefront/checkout', body: '{ customer_name, customer_email, items[], delivery_address?, tenant_id? }', description: 'Create pending orders + Paystack reference' },
        { method: 'POST', path: '/storefront/verify-payment', body: '{ reference, order_ids[] }', description: 'Verify Paystack payment client-side' },
        { method: 'GET', path: '/storefront/:tenantSlug/orders/:reference', description: 'Track order by order number or payment ref' },
        { method: 'GET', path: '/storefront/resolve-domain?host=', description: 'Resolve custom domain to tenant slug' },
      ],
      webhooks: [
        { method: 'POST', path: '/webhooks/paystack', description: 'Paystack charge.success (server backup verify)' },
      ],
    },
  });
});

module.exports = router;
