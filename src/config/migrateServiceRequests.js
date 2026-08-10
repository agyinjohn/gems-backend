/**
 * Carry existing print requests over to service requests.
 *
 * Print requests are service requests — they always were, the code just could
 * not say so. Three things move:
 *
 *   source        'print_request' → 'service_request'
 *   service_type  set to printing, because that is genuinely what they were
 *   items[].print_spec → items[].spec
 *
 * And the services those requests were placed against are tagged as printing
 * and marked as needing a file, because until now every request required one.
 * That keeps the shop working exactly as it did — a service nobody has ordered
 * yet is left alone at the plain default, for the shop to label itself.
 *
 * Required, not optional: the queue lists on source, so an unmigrated request
 * would simply stop appearing. Safe to re-run — every step matches only rows
 * that have not moved yet.
 *
 *   npm run db:migrate-service-requests
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./db');

async function run() {
  await connectDB();
  const db = mongoose.connection.db;
  const orders = db.collection('orders');
  const products = db.collection('products');

  console.log('\nMoving print requests to service requests…\n');

  // Which services were being sold this way, before the source is rewritten.
  const productIds = await orders.distinct('items.product_id', { source: 'print_request' });

  const moved = await orders.updateMany(
    { source: 'print_request' },
    { $set: { source: 'service_request', service_type: 'printing' } },
  );
  console.log(`  Requests moved:            ${moved.modifiedCount}`);

  // print_spec sits inside an array, which $rename cannot reach, so each order
  // carrying one is rewritten. Only ever set by this flow, so the scan is
  // narrow even though it is not filtered by source.
  const withSpec = await orders.find({ 'items.print_spec': { $exists: true } }).toArray();
  for (const order of withSpec) {
    const items = (order.items || []).map((item) => {
      if (!('print_spec' in item)) return item;
      const { print_spec, ...rest } = item;
      return { ...rest, spec: item.spec || print_spec || '' };
    });
    await orders.updateOne({ _id: order._id }, { $set: { items } });
  }
  console.log(`  Line specs renamed on:     ${withSpec.length} request(s)`);

  // Anything ordered through the old flow was print work, and needed a file.
  const ids = productIds.filter(Boolean);
  const tagged = ids.length
    ? await products.updateMany(
      { _id: { $in: ids }, item_type: 'service' },
      { $set: { service_type: 'printing', requires_file: true } },
    )
    : { modifiedCount: 0 };
  console.log(`  Services tagged as printing: ${tagged.modifiedCount}`);

  const left = await orders.countDocuments({ source: 'print_request' });
  console.log(left ? `\n  ${left} request(s) did not move — investigate.` : '\n  Nothing left on the old source.');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
