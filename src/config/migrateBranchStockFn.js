/**
 * One-time migration runner via HTTP.
 * Hit GET /api/admin/migrate-branch-stock with the server running.
 * Remove this route after the migration completes.
 */
const { Product } = require('../models');

async function migrateBranchStock() {
  const cursor = Product.find({
    item_type: { $ne: 'service' },
    is_active: true,
    $or: [
      { branch_stock: { $exists: false } },
      { branch_stock: { $size: 0 } },
    ],
  }).cursor();

  let processed = 0;
  for await (const product of cursor) {
    await Product.findByIdAndUpdate(product._id, {
      $set: {
        branch_stock: [{ branch_id: product.branch_id || null, qty: product.stock_qty || 0 }],
      },
    });
    processed++;
  }
  return processed;
}

module.exports = migrateBranchStock;
