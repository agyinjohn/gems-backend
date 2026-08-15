const { Product, Review, Tenant } = require('../models');
const reviews = require('../services/reviewService');
const variants = require('../services/variantService');

/**
 * Reading and writing what customers thought.
 *
 * The intake half is unauthenticated in the sense that a guest can use it, and
 * written defensively for exactly that reason: entitlement is established from
 * a paid order in this shop rather than from anything the sender claims, the
 * rating is coerced to a whole number in range, and the product's score is
 * recomputed from its reviews rather than adjusted by arithmetic on the way
 * past — an average nudged in place drifts, and there is no way to notice.
 */

const PAGE = 10;
const BODY_MAX = 1500;

async function findShop(slug) {
  return Tenant.findOne({ slug, is_active: true }).select('_id').lean();
}

async function findProduct(tenantId, productSlug) {
  return Product.findOne({ tenant_id: tenantId, slug: productSlug, is_active: true })
    .select('_id name variants rating_avg rating_count').lean();
}

/** What a customer has written about one product. */
const listReviews = async (req, res) => {
  const shop = await findShop(req.params.tenantSlug);
  if (!shop) return res.status(404).json({ success: false, message: 'Store not found.' });

  const product = await findProduct(shop._id, req.params.productSlug);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const [rows, total, all] = await Promise.all([
    Review.find({ tenant_id: shop._id, product_id: product._id })
      .sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean(),
    Review.countDocuments({ tenant_id: shop._id, product_id: product._id }),
    // The distribution is over every review, not the page being shown.
    Review.find({ tenant_id: shop._id, product_id: product._id }).select('rating').lean(),
  ]);

  res.json({
    success: true,
    data: {
      reviews: rows.map(reviews.publicReview),
      total,
      page,
      has_more: page * PAGE < total,
      rating_avg: product.rating_avg || 0,
      rating_count: product.rating_count || 0,
      breakdown: reviews.breakdownOf(all),
    },
  });
};

/**
 * Whether the person asking may leave one.
 *
 * Asked before the form is shown, so somebody who cannot review this is told
 * why up front rather than after writing three paragraphs. The answer is the
 * same rule the write path enforces, so the form never promises anything the
 * save will refuse.
 */
const reviewEligibility = async (req, res) => {
  const shop = await findShop(req.params.tenantSlug);
  if (!shop) return res.status(404).json({ success: false, message: 'Store not found.' });

  const product = await findProduct(shop._id, req.params.productSlug);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

  const email = req.storeCustomer?.email || req.query.email;
  if (!email) return res.json({ success: true, data: { allowed: false, reason: 'Sign in or give the email you ordered with.' } });

  const verdict = await reviews.eligibility({ tenantId: shop._id, productId: product._id, email });
  res.json({
    success: true,
    data: { allowed: verdict.allowed, reason: verdict.reason || '', reviewed: !!verdict.reviewed },
  });
};

/** Leave one. */
const createReview = async (req, res) => {
  const shop = await findShop(req.params.tenantSlug);
  if (!shop) return res.status(404).json({ success: false, message: 'Store not found.' });

  const product = await findProduct(shop._id, req.params.productSlug);
  if (!product) return res.status(404).json({ success: false, message: 'Product not found.' });

  // A signed-in customer is who the token says they are. A guest is who the
  // receipt went to — and the order lookup is what proves it, so a wrong email
  // buys nothing but a refusal.
  const email = req.storeCustomer?.email || req.body.email;
  const name = req.storeCustomer?.name || req.body.name;
  if (!email) return res.status(400).json({ success: false, message: 'Give the email you ordered with.' });
  if (!String(name || '').trim()) return res.status(400).json({ success: false, message: 'Please give your name.' });

  const rating = Math.round(Number(req.body.rating));
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ success: false, message: 'Choose between one and five stars.' });
  }

  const verdict = await reviews.eligibility({ tenantId: shop._id, productId: product._id, email });
  if (!verdict.allowed) return res.status(403).json({ success: false, message: verdict.reason });

  // Which one of it they bought, taken from the order rather than the form.
  const line = (verdict.order.items || []).find(i => String(i.product_id) === String(product._id));
  const variantLabel = line?.variant_label
    || variants.variantLabel(variants.findVariant(product, line?.variant_key));

  try {
    await Review.create({
      tenant_id: shop._id,
      product_id: product._id,
      order_id: verdict.order._id,
      variant_label: variantLabel || '',
      customer_name: String(name).trim().slice(0, 80),
      customer_email: String(email).toLowerCase().trim(),
      rating,
      body: String(req.body.body || '').trim().slice(0, BODY_MAX),
    });
  } catch (err) {
    // The unique index is the real guard against a double submit — two clicks
    // on a slow connection both pass the check above.
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, message: 'You have already reviewed this.' });
    }
    throw err;
  }

  const totals = await reviews.recomputeRating({ tenantId: shop._id, productId: product._id });
  res.status(201).json({ success: true, message: 'Thank you — your review is up.', data: totals });
};

module.exports = { listReviews, reviewEligibility, createReview };
