/**
 * Readable identifiers for things that end up in a URL.
 *
 * Tenants and branches each grew their own version of this inline. This one is
 * written for products, where the stakes are different: a product slug is a
 * public address that customers paste into WhatsApp, so it has to survive
 * accents, punctuation and duplicate names, and it must not change under a
 * link that has already been shared.
 */

/**
 * A name reduced to something that can sit in a path.
 *
 * Accents are folded rather than dropped — "Café" becoming "caf" loses a
 * letter, "cafe" keeps the word. Anything left that is not a letter or a digit
 * becomes a single hyphen.
 *
 * Returns an empty string when there is nothing usable, which is a real case:
 * a name written entirely in a non-Latin script reduces to nothing here, and
 * the caller has to decide what to do rather than being handed "".
 */
function slugify(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
}

/**
 * A slug no other product in this shop is using.
 *
 * Scoped per tenant: two shops may both sell a "kente stole" and neither
 * should have to be "kente-stole-2" because the other got there first.
 *
 * Every candidate is fetched in one query rather than probing the database
 * once per attempt — a shop with forty "T-Shirt" products would otherwise
 * make forty round trips to add the forty-first.
 */
async function uniqueSlug(Model, { tenant_id, name, fallback = 'item', excludeId = null }) {
  const base = slugify(name) || fallback;

  const taken = await Model.find({
    tenant_id,
    slug: new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`),
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).select('slug').lean();

  const used = new Set(taken.map(t => t.slug));
  if (!used.has(base)) return base;

  // Start at 2, because the first one is the unsuffixed name.
  for (let n = 2; n < used.size + 3; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  // Unreachable by the loop bound above, but a slug is required and silently
  // returning a duplicate would trip the unique index at save time.
  return `${base}-${Date.now().toString().slice(-5)}`;
}

module.exports = { slugify, uniqueSlug };
