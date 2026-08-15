/**
 * Which one of it you are buying.
 *
 * Most things a shop sells come one way: a stapler is a stapler. Clothing is
 * not — a polo shirt is a size and a colour, the shop has eleven navy mediums
 * and none in white extra-large, and a customer who is allowed to "add to cart"
 * without saying which has bought something nobody can pick from a shelf.
 *
 * Everything here exists to make one question answerable in one place: given a
 * product and what the customer chose, which row is that, and is there one?
 * Prices, stock, carts, orders and the picking list all ask it, and none of
 * them should be building the answer themselves.
 *
 * A product with no variants is not a special case anywhere in here. It has one
 * implicit combination — itself — and every function below says so, which is
 * what keeps the callers free of `if (product.variants.length)`.
 */

/** The word for a value, reduced to something two spellings agree on. */
const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * The canonical identity of a combination.
 *
 * Sorted by option name, so `{Colour: Navy, Size: M}` and `{Size: M, Colour:
 * Navy}` are the same row — a client that iterates an object in a different
 * order must not create a second stock count for the same shirt.
 *
 * Returns '' for no selections, which is the identity of a product that has no
 * options at all.
 */
function variantKey(selections) {
  const pairs = normalizeSelections(selections);
  if (!pairs.length) return '';
  return pairs
    .map(({ name, value }) => `${norm(name)}:${norm(value)}`)
    .sort()
    .join('|');
}

/**
 * Selections in one shape, whatever shape they arrived in.
 *
 * The storefront holds them as an object, the database stores them as an array
 * of rows, and an integration may send either. All three mean the same thing.
 */
function normalizeSelections(input) {
  if (!input) return [];
  const rows = Array.isArray(input)
    ? input
    : Object.entries(input).map(([name, value]) => ({ name, value }));

  return rows
    .filter(r => r && norm(r.name) && norm(r.value))
    .map(r => ({ name: String(r.name).trim(), value: String(r.value).trim() }));
}

/** Whether this product asks the customer to choose. */
function hasVariants(product) {
  return Array.isArray(product?.variants) && product.variants.some(v => v?.is_active !== false);
}

/** The live combinations, in the order the shop entered them. */
function liveVariants(product) {
  return (product?.variants || []).filter(v => v?.is_active !== false);
}

/**
 * The row the customer picked, or null.
 *
 * Null is returned for a product with no options too, and callers read that as
 * "there is no variant here" rather than "the choice was wrong" — which is why
 * `variantProblem` below exists separately.
 */
function findVariant(product, key) {
  if (!hasVariants(product)) return null;
  const wanted = String(key ?? '');
  return liveVariants(product).find(v => v.key === wanted) || null;
}

/**
 * What is wrong with this choice, in words a customer can act on. '' when
 * nothing is.
 *
 * Checked server-side and not merely in the form, because the form is not the
 * only thing that can post an order — and because "which shirt" decides what
 * comes off the shelf and what the shop is owed.
 */
function variantProblem(product, key) {
  if (!hasVariants(product)) return '';

  if (!key) {
    const asking = optionNames(product);
    const what = asking.length ? asking.join(' and ').toLowerCase() : 'an option';
    return `Choose a ${what} for ${product.name} first.`;
  }
  const found = findVariant(product, key);
  if (!found) return `That combination of ${product.name} is not one we sell.`;
  if (onHand(found) < 1) return `${product.name} — ${variantLabel(found)} is out of stock.`;
  return '';
}

/** The option names this product actually asks about, in first-seen order. */
function optionNames(product) {
  const seen = [];
  for (const v of liveVariants(product)) {
    for (const s of v.selections || []) {
      if (s?.name && !seen.some(n => norm(n) === norm(s.name))) seen.push(s.name);
    }
  }
  return seen;
}

/**
 * The options as a customer sees them: each name, and the values this product
 * actually stocks, with whether anything is left of each.
 *
 * Built from the product's own rows rather than from the category, because the
 * category lists every size the shop ever sells and this product may only come
 * in three of them. Offering a customer a size that was never made is worse
 * than offering one that has sold out.
 */
function optionMatrix(product) {
  if (!hasVariants(product)) return [];

  return optionNames(product).map(name => {
    const values = [];
    for (const v of liveVariants(product)) {
      const picked = (v.selections || []).find(s => norm(s.name) === norm(name));
      if (!picked?.value) continue;
      let row = values.find(x => norm(x.value) === norm(picked.value));
      if (!row) {
        row = { value: picked.value, in_stock: false };
        values.push(row);
      }
      // In stock if any combination carrying this value has something left —
      // navy is available while navy medium is, even once navy small has gone.
      if (onHand(v) > 0) row.in_stock = true;
    }
    return { name, values };
  });
}

/** On the shelf, less what a pending order is already holding. */
function onHand(row) {
  return Math.max(0, (row?.stock_qty || 0) - (row?.reserved_qty || 0));
}

/**
 * What this combination costs.
 *
 * The product's price plus the row's difference, floored at zero: a
 * mis-entered negative difference should make something free rather than make
 * a customer's total go down when they add to it.
 */
function priceOf(product, variant) {
  const base = Number(product?.price) || 0;
  if (!variant) return base;
  return Math.max(0, Math.round((base + (Number(variant.price_delta) || 0)) * 100) / 100);
}

/** "Size: M · Colour: Navy", for a cart line, an invoice or a picking list. */
function variantLabel(variant) {
  return (variant?.selections || [])
    .map(s => `${s.name}: ${s.value}`)
    .join(' · ');
}

/**
 * How many of this could be sold right now.
 *
 * The chosen combination when there is one; otherwise the product's own count.
 * A product that has options but has not been given a choice returns the total
 * across them, which is the honest answer to "does this shop have any" and is
 * never used to authorise a sale — variantProblem is.
 */
function availableFor(product, key) {
  if (!hasVariants(product)) return onHand(product);
  const found = findVariant(product, key);
  if (found) return onHand(found);
  return liveVariants(product).reduce((sum, v) => sum + onHand(v), 0);
}

/** The product's stock, which for a product with options is the sum of them. */
function totalStock(product) {
  if (!hasVariants(product)) return Number(product?.stock_qty) || 0;
  return liveVariants(product).reduce((sum, v) => sum + (Number(v.stock_qty) || 0), 0);
}

/**
 * Build the rows for a product from the values the shop ticked.
 *
 * Given `{ Size: ['S','M'], Colour: ['Navy','White'] }` this produces the four
 * combinations, carrying over the stock and price already recorded against any
 * that existed before. A shop editing a shirt to add extra-large must not have
 * the eleven navy mediums it already counted reset to zero.
 */
function buildVariants(chosenValues, existing = []) {
  const names = Object.keys(chosenValues || {}).filter(n => (chosenValues[n] || []).length);
  if (!names.length) return [];

  const previous = new Map((existing || []).map(v => [v.key, v]));

  let combos = [[]];
  for (const name of names) {
    const next = [];
    for (const combo of combos) {
      for (const value of chosenValues[name]) {
        if (!norm(value)) continue;
        next.push([...combo, { name, value: String(value).trim() }]);
      }
    }
    combos = next;
  }

  return combos.map(selections => {
    const key = variantKey(selections);
    const before = previous.get(key);
    return {
      key,
      selections,
      sku: before?.sku || '',
      price_delta: before?.price_delta || 0,
      stock_qty: before?.stock_qty || 0,
      reserved_qty: before?.reserved_qty || 0,
      is_active: before?.is_active !== false,
    };
  });
}

module.exports = {
  variantKey, normalizeSelections, hasVariants, liveVariants, findVariant,
  variantProblem, optionNames, optionMatrix, onHand, priceOf, variantLabel,
  availableFor, totalStock, buildVariants,
};
