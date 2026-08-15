const { Product } = require('../models');

/**
 * Which counter a catalogue item is sold over.
 *
 * The catalogue keeps three kinds of thing in one table, and until now the
 * storefront showed all three in one grid. That reads as a shop where you can
 * put "IT Support (per hour)" in a basket beside a stapler and pay for it, and
 * it is not how any of this actually works: work has to be looked at, priced
 * and agreed before it starts. The request pipeline — quote, accept, stages,
 * collection — has existed the whole time, sitting behind a page the shop front
 * never linked to.
 *
 * So there are two counters, and this decides which one a thing belongs at:
 *
 *   the shop     — bought. A price, a quantity, a cart, a card.
 *   the request desk — asked for. Described, quoted, agreed, then worked.
 *
 * A product is always bought and a service is always requested. A bundle is
 * whichever its contents make it: a package of goods is a package you buy, and
 * a package containing any work at all is a job somebody has to do. That is
 * decided from what is inside rather than from a flag, because a shop owner
 * assembling a package should not also have to classify it — and because a flag
 * can be left wrong, where contents cannot.
 */

/** Bought over the counter, no conversation required. */
const SHOP_TYPES = ['product', 'bundle'];

/**
 * The bundles that are really jobs.
 *
 * Two queries rather than one per bundle: the services first, then the bundles
 * that name one. A shop with two hundred packages would otherwise make two
 * hundred round trips to draw one page of a catalogue.
 *
 * Returns ObjectIds, ready to go straight into a filter.
 */
async function solutionIds(tenantId) {
  const services = await Product.find({ tenant_id: tenantId, item_type: 'service' })
    .select('_id').lean();
  if (!services.length) return [];

  const solutions = await Product.find({
    tenant_id: tenantId,
    item_type: 'bundle',
    'bundle_items.product_id': { $in: services.map(s => s._id) },
  }).select('_id').lean();

  return solutions.map(s => s._id);
}

/**
 * The filter fragment for things a customer can buy.
 *
 * Services are excluded by type. Bundles are excluded one by one, because
 * whether a bundle belongs here depends on what is in it.
 */
async function shopFilter(tenantId) {
  return {
    item_type: { $in: SHOP_TYPES },
    _id: { $nin: await solutionIds(tenantId) },
  };
}

/** The filter fragment for things a customer can ask to have done. */
async function requestFilter(tenantId) {
  return {
    $or: [
      { item_type: 'service' },
      { _id: { $in: await solutionIds(tenantId) } },
    ],
  };
}

/**
 * Whether this one item is sold over the counter.
 *
 * For the single-item cases — opening a product by its address, adding one to
 * a cart — where fetching the whole tenant's catalogue to answer a question
 * about one row would be absurd. The bundle's own contents are enough.
 */
async function isShopItem(product) {
  const type = product?.item_type || 'product';
  if (type === 'service') return false;
  if (type !== 'bundle') return true;

  const parts = (product.bundle_items || [])
    .map(b => (b.product_id && b.product_id._id) || b.product_id)
    .filter(Boolean);
  if (!parts.length) return true;

  const work = await Product.countDocuments({ _id: { $in: parts }, item_type: 'service' });
  return work === 0;
}

module.exports = { SHOP_TYPES, solutionIds, shopFilter, requestFilter, isShopItem };
