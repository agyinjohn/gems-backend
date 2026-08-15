const { Order, Product, Review, Tenant } = require('../models');
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

/* ── The customer's own ───────────────────────────────────────────────────── */

/**
 * What this customer has said, and what they have not said yet.
 *
 * Both halves matter. The first is theirs to look back at — and to correct,
 * which is why it can be edited: a one-star review left before the shop put the
 * problem right is a complaint the customer has no way to withdraw, and a
 * rating nobody can update is a rating that slowly stops being true.
 *
 * The second is the useful half for everybody. A customer who bought three
 * things and reviewed one is not refusing to review the others; they have
 * forgotten. Listing them where they will be seen is how a shop with four
 * reviews becomes a shop with forty.
 */
const myReviews = async (req, res) => {
  const customer = req.storeCustomer;

  const [mine, orders] = await Promise.all([
    Review.find({ tenant_id: customer.tenant_id, customer_email: customer.email })
      .populate('product_id', 'name slug images')
      .sort({ createdAt: -1 }).lean(),
    Order.find({
      tenant_id: customer.tenant_id,
      customer_email: customer.email,
      payment_status: 'paid',
    }).select('_id order_number items createdAt').sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  const reviewed = new Set(mine.map(r => `${r.product_id?._id || r.product_id}|${r.order_id}`));

  // Everything bought and not yet spoken about. A product bought twice and
  // reviewed once still has one waiting, which is the same rule the write path
  // applies — the two must agree or this list offers something the save
  // refuses.
  const awaiting = [];
  const seen = new Set();
  for (const order of orders) {
    for (const line of order.items || []) {
      if (!line.product_id) continue;
      // Work is requested and quoted rather than bought off a shelf, and is
      // not rated here.
      if (line.item_type === 'service') continue;
      const key = `${line.product_id}|${order._id}`;
      if (reviewed.has(key) || seen.has(key)) continue;
      seen.add(key);
      awaiting.push({
        product_id: String(line.product_id),
        product_name: line.product_name,
        variant_label: line.variant_label || '',
        order_number: order.order_number,
        bought_at: order.createdAt,
      });
    }
  }

  // The addresses, so each row can link to the page that takes the review.
  const slugs = new Map();
  if (awaiting.length) {
    const products = await Product.find({ _id: { $in: awaiting.map(a => a.product_id) } })
      .select('slug images').lean();
    for (const p of products) slugs.set(String(p._id), { slug: p.slug || '', image: (p.images || [])[0] || '' });
  }

  res.json({
    success: true,
    data: {
      written: mine.map(r => ({
        id: String(r._id),
        product_name: r.product_id?.name || 'A product that has since been removed',
        product_slug: r.product_id?.slug || '',
        product_image: (r.product_id?.images || [])[0] || '',
        variant_label: r.variant_label || '',
        rating: r.rating,
        body: r.body || '',
        // The shop's answer, which is the reason to come back and look.
        reply: r.reply || '',
        replied_at: r.replied_at || null,
        // Said plainly rather than hidden from them: their words are off the
        // shop front, and their rating still counts.
        is_hidden: !!r.is_hidden,
        created_at: r.createdAt,
      })),
      awaiting: awaiting.slice(0, 20).map(a => ({
        ...a,
        product_slug: slugs.get(a.product_id)?.slug || '',
        product_image: slugs.get(a.product_id)?.image || '',
      })),
    },
  });
};

/** Change your mind about something you said. */
const updateMyReview = async (req, res) => {
  const customer = req.storeCustomer;
  const review = await Review.findOne({
    _id: req.params.id,
    tenant_id: customer.tenant_id,
    // Their own, and only their own. The id alone is not authorisation.
    customer_email: customer.email,
  });
  if (!review) return res.status(404).json({ success: false, message: 'Review not found.' });

  if (req.body.rating !== undefined) {
    const rating = Math.round(Number(req.body.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: 'Choose between one and five stars.' });
    }
    review.rating = rating;
  }
  if (req.body.body !== undefined) review.body = String(req.body.body || '').trim().slice(0, BODY_MAX);

  await review.save();
  // The score follows, because the rating may have moved.
  const totals = await reviews.recomputeRating({
    tenantId: customer.tenant_id, productId: review.product_id,
  });
  res.json({ success: true, message: 'Updated.', data: totals });
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
  myReviews, updateMyReview,
  merchantReviews, updateReviewByShop,
};
