const { Product } = require('../models');

function availableQty(product) {
  return Math.max(0, (product.stock_qty || 0) - (product.reserved_qty || 0));
}

async function assertItemsAvailable({ tenantId, items }) {
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, tenant_id: tenantId, is_active: true });
    if (!p) {
      const err = new Error('Product not found.');
      err.status = 400;
      throw err;
    }
    if (availableQty(p) < item.quantity) {
      const err = new Error(`Insufficient stock for ${p.name}.`);
      err.status = 400;
      throw err;
    }
  }
}

async function reserveStockForItems({ tenantId, items }) {
  await assertItemsAvailable({ tenantId, items });

  for (const item of items) {
    const updated = await Product.findOneAndUpdate(
      {
        _id: item.product_id,
        tenant_id: tenantId,
        $expr: {
          $gte: [
            { $subtract: ['$stock_qty', { $ifNull: ['$reserved_qty', 0] }] },
            item.quantity,
          ],
        },
      },
      { $inc: { reserved_qty: item.quantity } },
      { new: true },
    );

    if (!updated) {
      const p = await Product.findById(item.product_id);
      const err = new Error(`Could not reserve stock for ${p?.name || 'product'}.`);
      err.status = 400;
      throw err;
    }
  }
}

async function releaseStockForItems({ tenantId, items }) {
  for (const item of items) {
    const p = await Product.findOneAndUpdate(
      { _id: item.product_id, tenant_id: tenantId },
      { $inc: { reserved_qty: -item.quantity } },
      { new: true },
    );
    if (p && p.reserved_qty < 0) {
      await Product.findByIdAndUpdate(p._id, { reserved_qty: 0 });
    }
  }
}

function mapOrderItems(order) {
  return (order.items || []).map((i) => ({
    product_id: i.product_id,
    quantity: i.quantity,
  }));
}

module.exports = {
  availableQty,
  assertItemsAvailable,
  reserveStockForItems,
  releaseStockForItems,
  mapOrderItems,
};
