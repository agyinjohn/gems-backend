const { Product } = require('../models');
const { stockLines, shortageFor, availableQty: availableFor } = require('./stockService');

/**
 * Stock held back for a sale that has been started but not paid for.
 *
 * Only stocked products are ever held. A service has nothing to hold, and a
 * solution holds its parts rather than itself, so what gets reserved for a
 * package is the same set of rows the sale will eventually draw down.
 */

/**
 * Every stocked row a cart touches, with the quantity it needs, one line each.
 * Giving back what is no longer needed must not be stopped by one missing row,
 * so that direction skips what it cannot find rather than throwing.
 */
async function stockLinesForItems({ tenantId, items, skipMissing = false }) {
  const lines = [];
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, tenant_id: tenantId, is_active: true });
    if (!p) {
      if (skipMissing) continue;
      const err = new Error('Product not found.');
      err.status = 400;
      throw err;
    }
    lines.push(...await stockLines({ tenantId, product: p, quantity: item.quantity }));
  }
  return lines;
}

async function assertItemsAvailable({ tenantId, items }) {
  for (const item of items) {
    const p = await Product.findOne({ _id: item.product_id, tenant_id: tenantId, is_active: true });
    if (!p) {
      const err = new Error('Product not found.');
      err.status = 400;
      throw err;
    }
    const shortage = await shortageFor({ tenantId, product: p, quantity: item.quantity });
    if (shortage) {
      const err = new Error(shortage);
      err.status = 400;
      throw err;
    }
  }
}

async function reserveStockForItems({ tenantId, items }) {
  await assertItemsAvailable({ tenantId, items });

  for (const line of await stockLinesForItems({ tenantId, items })) {
    const updated = await Product.findOneAndUpdate(
      {
        _id: line.product_id,
        tenant_id: tenantId,
        $expr: {
          $gte: [
            { $subtract: ['$stock_qty', { $ifNull: ['$reserved_qty', 0] }] },
            line.quantity,
          ],
        },
      },
      { $inc: { reserved_qty: line.quantity } },
      { new: true },
    );

    if (!updated) {
      const err = new Error(`Could not reserve stock for ${line.name || 'product'}.`);
      err.status = 400;
      throw err;
    }
  }
}

async function releaseStockForItems({ tenantId, items }) {
  // Expanded the same way it was reserved. If a solution was re-composed in
  // between, the release follows the composition as it stands now — the same
  // assumption the deduction path makes.
  for (const line of await stockLinesForItems({ tenantId, items, skipMissing: true })) {
    const p = await Product.findOneAndUpdate(
      { _id: line.product_id, tenant_id: tenantId },
      { $inc: { reserved_qty: -line.quantity } },
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
  availableFor,
  stockLinesForItems,
  assertItemsAvailable,
  reserveStockForItems,
  releaseStockForItems,
  mapOrderItems,
};
