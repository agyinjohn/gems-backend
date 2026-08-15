const { Product, Review, Tenant } = require('../models');
const reviews = require('../services/reviewService');
const variants = require('../services/variantService');
const audit = require('../utils/audit');

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

/* ── The shop's side ──────────────────────────────────────────────────────── */

const MERCHANT_PAGE = 25;
const REPLY_MAX = 1000;

/**
 * Everything customers have said about this shop.
 *
 * Scoped to the tenant by the middleware, filtered by whatever the owner is
 * looking for, and carrying the product name — a list of ratings with no
 * indication of what was rated is not something anybody can act on.
 *
 * The email comes through here where it does not on the public side: a shop
 * dealing with a complaint needs to be able to reach the person who made it.
 */
const merchantReviews = async (req, res) => {
  const { rating, hidden, product_id, search, page = 1 } = req.query;

  const filter = { tenant_id: req.tenant_id };
  if (rating) filter.rating = Number(rating);
  if (hidden === 'true') filter.is_hidden = true;
  if (hidden === 'false') filter.is_hidden = { $ne: true };
  if (product_id) filter.product_id = product_id;
  if (search) {
    filter.$or = [
      { customer_name: new RegExp(search, 'i') },
      { body: new RegExp(search, 'i') },
    ];
  }

  const current = Math.max(1, parseInt(page, 10) || 1);
  const [rows, total, all] = await Promise.all([
    Review.find(filter)
      .populate('product_id', 'name slug images')
      .populate('order_id', 'order_number')
      .sort({ createdAt: -1 })
      .skip((current - 1) * MERCHANT_PAGE).limit(MERCHANT_PAGE).lean(),
    Review.countDocuments(filter),
    // The shop-wide picture is of every review, not of the filtered page —
    // an owner looking at the one-star filter still wants to know the average
    // is 4.4, or the page tells them their shop is in trouble when it is not.
    Review.find({ tenant_id: req.tenant_id }).select('rating is_hidden reply').lean(),
  ]);

  const count = all.length;
  const summary = {
    total: count,
    rating_avg: count ? reviews.round1(all.reduce((t, r) => t + r.rating, 0) / count) : 0,
    breakdown: reviews.breakdownOf(all),
    hidden: all.filter(r => r.is_hidden).length,
    // What is waiting on the shop: a poor review nobody has answered.
    needs_reply: all.filter(r => r.rating <= 3 && !String(r.reply || '').trim()).length,
  };

  res.json({
    success: true,
    data: {
      reviews: rows.map(r => ({
        id: String(r._id),
        product_id: String(r.product_id?._id || r.product_id || ''),
        product_name: r.product_id?.name || 'A product that has since been removed',
        product_slug: r.product_id?.slug || '',
        product_image: (r.product_id?.images || [])[0] || '',
        order_number: r.order_id?.order_number || '',
        customer_name: r.customer_name,
        // Shown to the shop and to nobody else, so a complaint can be answered
        // off the page as well as on it.
        customer_email: r.customer_email,
        variant_label: r.variant_label || '',
        rating: r.rating,
        body: r.body || '',
        reply: r.reply || '',
        replied_at: r.replied_at || null,
        is_hidden: !!r.is_hidden,
        created_at: r.createdAt,
      })),
      total,
      page: current,
      has_more: current * MERCHANT_PAGE < total,
      summary,
    },
  });
};

/**
 * Take a review down, put it back, or answer it.
 *
 * There is no delete, and that is deliberate. Hiding a review removes its text
 * from the shop front and leaves its rating in the average, so a shop can deal
 * with something abusive or that names a person without being able to improve
 * its own score by deleting the two-star reviews. A shop that could delete them
 * would have a rating worth nothing, which is the thing this whole feature is
 * for.
 */
const updateReviewByShop = async (req, res) => {
  const review = await Review.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!review) return res.status(404).json({ success: false, message: 'Review not found.' });

  if (req.body.is_hidden !== undefined) review.is_hidden = !!req.body.is_hidden;

  if (req.body.reply !== undefined) {
    const reply = String(req.body.reply || '').trim().slice(0, REPLY_MAX);
    review.reply = reply;
    // Cleared rather than kept when a reply is removed, so "replied 3 weeks
    // ago" cannot outlive the reply it was describing.
    review.replied_at = reply ? new Date() : null;
  }

  await review.save();
  await audit(req, 'UPDATE_REVIEW', 'storefront',
    `${req.user.name} ${req.body.is_hidden !== undefined ? (review.is_hidden ? 'hid' : 'restored') : 'replied to'} a review`,
    { review_id: String(review._id), rating: review.rating, hidden: review.is_hidden },
  );

  res.json({ success: true, message: review.is_hidden ? 'Review hidden.' : 'Saved.', data: { id: String(review._id) } });
};

module.exports = {
  listReviews, reviewEligibility, createReview,
  merchantReviews, updateReviewByShop,
};
