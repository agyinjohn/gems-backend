/**
 * Migration: backfill branch_stock from existing stock_qty
 *
 * For every active physical product that has no branch_stock entries yet,
 * create one entry: { branch_id: product.branch_id, qty: product.stock_qty }.
 *
 * This is safe to run multiple times — products that already have branch_stock
 * entries are skipped.
 *
 * Run with:  npm run db:migrate-branch-stock
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL);
  console.log('Connected to MongoDB');

  const Product = mongoose.model('Product', new mongoose.Schema({}, { strict: false }), 'products');

  const cursor = Product.find({
    item_type: { $ne: 'service' },
    is_active: true,
    $or: [
      { branch_stock: { $exists: false } },
      { branch_stock: { $size: 0 } },
    ],
  }).cursor();

  let processed = 0;
  let skipped = 0;

  for await (const product of cursor) {
    const qty = product.stock_qty || 0;
    const branchId = product.branch_id || null;

    await Product.findByIdAndUpdate(product._id, {
      $set: {
        branch_stock: [{ branch_id: branchId, qty }],
      },
    });

    processed++;
    if (processed % 100 === 0) console.log(`  Processed ${processed}…`);
  }

  // Also handle variant stock — each variant already has its own stock_qty,
  // so the product-level branch_stock entry is the sum (already correct from
  // the product's stock_qty which variantService keeps in sync).

  console.log(`\nDone. Backfilled: ${processed}, Already had branch_stock: ${skipped}`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
