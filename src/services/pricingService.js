/**
 * Line pricing.
 *
 * Price is decided server-side. A client may propose a price only for catalog
 * items explicitly marked `pricing_mode: 'open'` — repairs, quotes and other
 * bespoke work whose amount isn't known until it's rung up. For everything else
 * a submitted price is ignored outright, so a tampered client can't ring a
 * laptop up at GHS 0.01.
 *
 * Both sale paths go through here so they can't drift apart on the rule.
 */

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

/**
 * The unit price to charge for a line.
 *
 * @param product      the catalog document
 * @param proposed     price sent by the client, if any
 * @param allowOverride false for channels where nobody is present to quote —
 *                      a storefront customer can't price their own job
 * @returns { unit_price } or throws a 400-shaped error
 */
function resolveUnitPrice({ product, proposed, allowOverride = true }) {
  const isOpen = product.pricing_mode === 'open';

  if (!isOpen) {
    // Fixed pricing: the catalog is authoritative and any proposal is dropped.
    return { unit_price: round2(product.price) };
  }

  if (!allowOverride) {
    throw Object.assign(
      new Error(`${product.name} is priced on request and can't be bought online.`),
      { status: 400 },
    );
  }

  const value = Number(proposed);
  if (!Number.isFinite(value) || value <= 0) {
    throw Object.assign(
      new Error(`Enter a price for ${product.name}.`),
      { status: 400 },
    );
  }

  const min = Number(product.min_price) || 0;
  const max = Number(product.max_price) || 0;
  if (min > 0 && value < min) {
    throw Object.assign(
      new Error(`${product.name} cannot be sold below GHS ${min.toFixed(2)}.`),
      { status: 400 },
    );
  }
  if (max > 0 && value > max) {
    throw Object.assign(
      new Error(`${product.name} cannot be sold above GHS ${max.toFixed(2)}.`),
      { status: 400 },
    );
  }

  return { unit_price: round2(value) };
}

/** Open-price items can't be listed for self-service purchase. */
function isQuoteOnly(product) {
  return product?.pricing_mode === 'open';
}

module.exports = { resolveUnitPrice, isQuoteOnly, round2 };
