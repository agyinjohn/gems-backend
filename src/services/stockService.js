const { Product } = require('../models');

/**
 * What is actually held on a shelf.
 *
 * The catalogue keeps three kinds of thing in one table and only one of them
 * has stock. A service is work: the same one can be sold twice in a minute and
 * nothing runs out. A solution is a package of other things, so what limits it
 * is the scarcest of its parts — never its own count, which is always zero.
 *
 * Everything that sells, reserves or deducts asks here, because the alternative
 * — every caller remembering what kind of row it is holding — is how a binding
 * and finishing service came to be refused at the till for being out of stock.
 */

/** Nothing limits it. Compares correctly against any quantity. */
const UNLIMITED = Infinity;

/** Only a plain product is held on a shelf. */
const isStocked = (product) => (product?.item_type || 'product') === 'product';

/** A reference is either an id or, once populated, the document itself. */
const refId = (value) => String((value && value._id) || value || '');

/** On the shelf, less what a pending sale is already holding. */
const onHand = (product) => Math.max(0, (product.stock_qty || 0) - (product.reserved_qty || 0));

/**
 * The stocked products a line really draws down, and how many of each.
 *
 * A service draws down nothing. A solution draws down its parts — the stocked
 * ones; a service inside a package is still just work, and decrementing it was
 * driving perfectly ordinary services into negative stock. A solution inside a
 * solution is left alone rather than followed, which is what every deduction
 * path here has always done.
 */
async function stockLines({ tenantId, product, quantity }) {
  if (isStocked(product)) {
    return [{ product_id: product._id, name: product.name, quantity, product }];
  }
  if (product.item_type !== 'bundle') return [];

  const lines = [];
  for (const part of product.bundle_items || []) {
    const comp = await Product.findOne({
      _id: refId(part.product_id),
      ...(tenantId ? { tenant_id: tenantId } : {}),
    });
    if (!comp || !isStocked(comp)) continue;
    lines.push({
      product_id: comp._id,
      name: comp.name,
      quantity: (Number(part.quantity) || 1) * quantity,
      product: comp,
    });
  }
  return lines;
}

/** How many of this could be sold right now. UNLIMITED when nothing limits it. */
async function availableQty({ tenantId, product }) {
  if (!product) return 0;
  if (isStocked(product)) return onHand(product);

  const lines = await stockLines({ tenantId, product, quantity: 1 });
  return lines.reduce(
    (limit, line) => Math.min(limit, Math.floor(onHand(line.product) / line.quantity)),
    UNLIMITED,
  );
}

/**
 * Null when the line can be sold, otherwise what to tell whoever is selling it.
 * A solution names the part that ran out, since that is the one to reorder.
 */
async function shortageFor({ tenantId, product, quantity }) {
  if (isStocked(product)) {
    return onHand(product) >= quantity ? null : `Insufficient stock for ${product.name}.`;
  }
  for (const line of await stockLines({ tenantId, product, quantity })) {
    if (onHand(line.product) < line.quantity) {
      return `Insufficient stock for bundle component "${line.name}".`;
    }
  }
  return null;
}

module.exports = {
  UNLIMITED,
  isStocked,
  onHand,
  stockLines,
  availableQty,
  shortageFor,
};
