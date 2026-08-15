const { Order, Product, Review } = require('../models');

/**
 * What customers said, and who is allowed to say it.
 *
 * A storefront rating is only worth reading if it cost something to leave. So
 * there is exactly one way in: an order, paid, containing this product, in this
 * shop. Every review is therefore a verified purchase — not a badge some of
 * them earn, but the only kind that can exist.
 *
 * That rule lives here rather than in the route because two things enforce it —
 * a logged-in customer leaving a review, and a guest doing it with their order
 * number — and a rule written twice is a rule that will eventually be written
 * differently.
 */

/** A rounded average, to one decimal place. 4.3, not 4.285714285714286. */
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * The orders that entitle this person to review this product.
 *
 * Matched on email rather than on a customer record, because most storefront
 * orders are placed by guests who never made an account, and their proof of
 * purchase is the address the receipt went to.
 *
 * Only paid orders count. An order placed and never paid for is not a purchase,
 * and treating it as one would make the entitlement free to anybody who can
 * reach the checkout.
 */
async function purchasesOf({ tenantId, productId, email }) {
  if (!tenantId || !productId || !email) return [];
  return Order.find({
    tenant_id: tenantId,
    customer_email: String(email).toLowerCase().trim(),
    payment_status: 'paid',
    'items.product_id': productId,
  }).select('_id order_number items createdAt').sort({ createdAt: -1 }).lean();
}

/**
 * Whether this person may review this product, and on which order.
 *
 * Returns the order to attach the review to, or a reason they cannot — worded
 * for the customer, since it is shown to them. A customer who has bought the
 * same shirt three times and reviewed it twice may review it once more; one who
 * has reviewed every order has run out of things to attach a review to, which
 * is the honest way to say "you have already reviewed this".
 */
async function eligibility({ tenantId, productId, email }) {
  const orders = await purchasesOf({ tenantId, productId, email });
  if (!orders.length) {
    return { allowed: false, reason: 'Only customers who have bought this can review it.' };
  }

  const already = await Review.find({
    tenant_id: tenantId,
    product_id: productId,
    customer_email: String(email).toLowerCase().trim(),
  }).select('order_id').lean();

  const used = new Set(already.map(r => String(r.order_id)));
  const open = orders.find(o => !used.has(String(o._id)));
  if (!open) {
    return { allowed: false, reason: 'You have already reviewed this.', reviewed: true };
  }
  return { allowed: true, order: open };
}

/**
 * Recount a product's score from its reviews.
 *
 * Hidden reviews still count. A shop can take down a review that is abusive or
 * names somebody; it must not be able to take down a review for being two stars
 * and watch its average climb, which is what excluding them here would buy.
 */
async function recomputeRating({ tenantId, productId }) {
  const [summary] = await Review.aggregate([
    { $match: { tenant_id: tenantId, product_id: productId } },
    { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$rating' } } },
  ]);

  const count = summary?.count || 0;
  const avg = count ? round1(summary.total / count) : 0;
  await Product.updateOne({ _id: productId }, { $set: { rating_avg: avg, rating_count: count } });
  return { rating_avg: avg, rating_count: count };
}

/** How the stars are distributed, for the bar chart beside the average. */
function breakdownOf(reviews) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of reviews) {
    const star = Math.round(Number(r.rating) || 0);
    if (counts[star] !== undefined) counts[star]++;
  }
  return counts;
}

/**
 * A reviewer's name, shortened the way a shop would print it.
 *
 * "Kwame A." rather than "Kwame Asante": enough for the next customer to see a
 * person wrote this, not enough to identify somebody from their purchases. The
 * email is never published at all.
 */
function displayName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A customer';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** One review, as the public may see it. */
function publicReview(r) {
  return {
    id: String(r._id),
    name: displayName(r.customer_name),
    rating: r.rating,
    body: r.is_hidden ? '' : (r.body || ''),
    hidden: !!r.is_hidden,
    variant_label: r.variant_label || '',
    // Every one of them, because every one of them had to be.
    verified: true,
    created_at: r.createdAt,
  };
}

module.exports = {
  purchasesOf, eligibility, recomputeRating, breakdownOf, displayName, publicReview, round1,
};
