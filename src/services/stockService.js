const { Product } = require('../models');
const variants = require('./variantService');

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

/**
 * On the shelf, less what a pending sale is already holding.
 *
 * For a product sold in sizes and colours, what is on the shelf is the row the
 * customer picked — eleven navy mediums, not the forty shirts across every
 * combination. Without a choice it is the total, which answers "does this shop
 * have any" and is never what authorises a sale; variantService.variantProblem
 * is.
 */
const onHand = (product, variantKey) => {
  if (variants.hasVariants(product)) return variants.availableFor(product, variantKey);
  return Math.max(0, (product.stock_qty || 0) - (product.reserved_qty || 0));
};

/**
 * The stocked products a line really draws down, and how many of each.
 *
 * A service draws down nothing. A solution draws down its parts — the stocked
 * ones; a service inside a package is still just work, and decrementing it was
 * driving perfectly ordinary services into negative stock. A solution inside a
 * solution is left alone rather than followed, which is what every deduction
 * path here has always done.
 */
async function stockLines({ tenantId, product, quantity, variantKey }) {
  if (isStocked(product)) {
    // The chosen row is carried through, because a sale of eleven navy mediums
    // has to come off the navy mediums. A deduction against the product would
    // leave the size the customer actually took still showing as in stock.
    const chosen = variants.findVariant(product, variantKey);
    return [{
      product_id: product._id,
      name: chosen ? `${product.name} (${variants.variantLabel(chosen)})` : product.name,
      quantity,
      product,
      variant_key: chosen ? chosen.key : '',
    }];
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
      // A package cannot say which size of a thing it contains, so a component
      // sold in sizes has no row to come off. Flagged rather than guessed at:
      // deducting the product would leave every size still reading as in stock
      // while the shelf emptied, and inventory that lies is worse than a
      // package that refuses to sell.
      needs_choice: variants.hasVariants(comp),
    });
  }
  return lines;
}

/** How many of this could be sold right now. UNLIMITED when nothing limits it. */
async function availableQty({ tenantId, product, variantKey }) {
  if (!product) return 0;
  if (isStocked(product)) return onHand(product, variantKey);

  const lines = await stockLines({ tenantId, product, quantity: 1 });
  if (lines.some(line => line.needs_choice)) return 0;
  return lines.reduce(
    (limit, line) => Math.min(limit, Math.floor(onHand(line.product) / line.quantity)),
    UNLIMITED,
  );
}

/**
 * Null when the line can be sold, otherwise what to tell whoever is selling it.
 * A solution names the part that ran out, since that is the one to reorder.
 */
async function shortageFor({ tenantId, product, quantity, variantKey }) {
  if (isStocked(product)) {
    // A wrong or missing choice is a different complaint from a shortage, and
    // is worded for whoever has to act on it.
    const problem = variants.variantProblem(product, variantKey);
    if (problem) return problem;
    if (onHand(product, variantKey) >= quantity) return null;

    const chosen = variants.findVariant(product, variantKey);
    return chosen
      ? `Insufficient stock for ${product.name} — ${variants.variantLabel(chosen)}.`
      : `Insufficient stock for ${product.name}.`;
  }
  for (const line of await stockLines({ tenantId, product, quantity })) {
    if (line.needs_choice) {
      return `"${line.name}" is sold in options, so it cannot be part of a package. Remove it from ${product.name}.`;
    }
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
