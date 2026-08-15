/**
 * Give every existing product a public address.
 *
 * Slugs are generated when a product is created, so only the catalogue that
 * existed before this feature needs filling in. Until it runs, those products
 * have no address: the storefront can still show them in the grid, but a
 * customer cannot be sent a link to one and a search engine has nothing to
 * index.
 *
 * Safe to re-run. It only touches products with no slug, so a second run does
 * nothing, and it never changes a slug that already exists — that is the whole
 * promise of a slug, and a migration that quietly reassigned them would break
 * every link already shared.
 *
 * Uniqueness is per tenant, and worked out in memory per tenant rather than by
 * asking the database once per product. A shop with two hundred products named
 * some variation of "T-Shirt" would otherwise make two hundred round trips.
 *
 *   npm run db:backfill-product-slugs
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./db');
const { slugify } = require('../utils/slug');

async function run() {
  await connectDB();
  const products = mongoose.connection.db.collection('products');

  const missing = await products
    .find({ $or: [{ slug: { $exists: false } }, { slug: null }, { slug: '' }] })
    .project({ _id: 1, tenant_id: 1, name: 1 })
    .toArray();

  if (!missing.length) {
    console.log('Every product already has a slug. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // What each tenant is already using, so the backfill does not collide with
  // products created since slugs were introduced.
  const taken = new Map();
  const existing = await products
    .find({ slug: { $nin: [null, ''] } })
    .project({ tenant_id: 1, slug: 1 })
    .toArray();
  for (const row of existing) {
    const key = String(row.tenant_id);
    if (!taken.has(key)) taken.set(key, new Set());
    taken.get(key).add(row.slug);
  }

  let written = 0;
  const ops = [];

  for (const product of missing) {
    const key = String(product.tenant_id);
    if (!taken.has(key)) taken.set(key, new Set());
    const used = taken.get(key);

    const base = slugify(product.name) || 'item';
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;

    used.add(slug);
    ops.push({ updateOne: { filter: { _id: product._id }, update: { $set: { slug } } } });
    written++;
  }

  // In batches, so a large catalogue does not build one enormous command.
  for (let i = 0; i < ops.length; i += 500) {
    await products.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }

  console.log(`Gave ${written} product(s) an address across ${taken.size} shop(s).`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
