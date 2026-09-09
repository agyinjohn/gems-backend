const mongoose = require('mongoose');

/**
 * The single place that writes branch-level stock.
 *
 * Every sale, purchase, adjustment, transfer and reconciliation goes through
 * here. Nothing else should touch stock_qty or branch_stock directly.
 *
 * What it does:
 *   1. Finds or creates the branch_stock entry for the given branch.
 *   2. Applies the delta (positive = stock in, negative = stock out).
 *   3. Recomputes stock_qty as the sum of all branch entries.
 *   4. Returns the updated product.
 *
 * branchId may be null for single-branch tenants or legacy records — in that
 * case the adjustment is applied to a sentinel entry with branch_id: null,
 * which keeps the total correct without requiring every old record to be
 * backfilled to a real branch first.
 */
async function adjustBranchStock(Product, productId, branchId, delta) {
  const bid = branchId ? new mongoose.Types.ObjectId(String(branchId)) : null;

  // Find the matching entry. For null branch_id we match on null explicitly.
  const matchField = bid
    ? { 'branch_stock.branch_id': bid }
    : { 'branch_stock.branch_id': null };

  // Try to increment an existing entry first.
  let product = await Product.findOneAndUpdate(
    { _id: productId, ...matchField },
    { $inc: { 'branch_stock.$.qty': delta } },
    { new: true },
  );

  if (!product) {
    // Entry doesn't exist yet — push a new one then re-fetch.
    await Product.findByIdAndUpdate(productId, {
      $push: { branch_stock: { branch_id: bid, qty: Math.max(0, delta) } },
    });
    product = await Product.findById(productId);
  }

  // Recompute the total and persist it.
  const total = (product.branch_stock || []).reduce((s, e) => s + (e.qty || 0), 0);
  product = await Product.findByIdAndUpdate(
    productId,
    { $set: { stock_qty: total } },
    { new: true },
  );

  return product;
}

/**
 * Set a branch's stock to an exact quantity (used by reconciliation).
 * Creates the entry if it doesn't exist, then recomputes the total.
 */
async function setBranchStock(Product, productId, branchId, qty) {
  const bid = branchId ? new mongoose.Types.ObjectId(String(branchId)) : null;
  const safeQty = Math.max(0, qty);

  const matchField = bid
    ? { 'branch_stock.branch_id': bid }
    : { 'branch_stock.branch_id': null };

  let product = await Product.findOneAndUpdate(
    { _id: productId, ...matchField },
    { $set: { 'branch_stock.$.qty': safeQty } },
    { new: true },
  );

  if (!product) {
    await Product.findByIdAndUpdate(productId, {
      $push: { branch_stock: { branch_id: bid, qty: safeQty } },
    });
    product = await Product.findById(productId);
  }

  const total = (product.branch_stock || []).reduce((s, e) => s + (e.qty || 0), 0);
  product = await Product.findByIdAndUpdate(
    productId,
    { $set: { stock_qty: total } },
    { new: true },
  );

  return product;
}

/**
 * How much stock a specific branch holds for a product.
 * Returns 0 if the branch has no entry yet.
 */
function branchQty(product, branchId) {
  if (!product?.branch_stock?.length) return product?.stock_qty || 0;
  const bid = String(branchId || '');
  const entry = product.branch_stock.find(e => String(e.branch_id || '') === bid);
  return entry?.qty || 0;
}

module.exports = { adjustBranchStock, setBranchStock, branchQty };
