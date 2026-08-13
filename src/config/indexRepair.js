const mongoose = require('mongoose');

/**
 * Replaces indexes that were declared sparse when they meant partial.
 *
 * Changing the declaration in the schema does nothing to a database that
 * already has the old index: MongoDB will not quietly rebuild an index under
 * the same name with different options, so the wrong one stays and keeps
 * refusing writes. This drops it and puts the right one back.
 *
 * Runs on boot because the symptom is a shop that cannot take payment —
 * "E11000 duplicate key ... track_token: null" on the second order of the day —
 * and telling somebody to go and run a script while the till is down is not a
 * fix. It is idempotent: once the index is right, it looks and leaves.
 */

/**
 * Every index that meant "unique among the rows that have one". Named by model
 * rather than by collection, so nobody has to guess how Mongoose pluralised it.
 */
const EXPECTED = [
  { model: 'Order', name: 'track_token_1', key: { track_token: 1 }, when: 'track_token' },
  { model: 'Project', name: 'track_token_1', key: { track_token: 1 }, when: 'track_token' },
  { model: 'Product', name: 'tenant_id_1_sku_1', key: { tenant_id: 1, sku: 1 }, when: 'sku' },
  { model: 'StorageLocation', name: 'tenant_id_1_code_1', key: { tenant_id: 1, code: 1 }, when: 'code' },
];

const filterFor = (field) => ({ [field]: { $type: 'string' } });

const isRight = (index, field) => index.unique === true
  && JSON.stringify(index.partialFilterExpression || null) === JSON.stringify(filterFor(field));

async function repairIndex(connection, spec) {
  const model = connection.models[spec.model] || mongoose.models[spec.model];
  if (!model) return 'absent';
  const collection = model.collection;

  let existing;
  try {
    existing = await collection.indexes();
  } catch {
    return 'absent'; // nothing created this collection yet; the model will
  }

  const current = existing.find((i) => i.name === spec.name);
  if (current && isRight(current, spec.when)) return 'ok';

  if (current) await collection.dropIndex(spec.name);
  try {
    await collection.createIndex(spec.key, {
      name: spec.name,
      unique: true,
      partialFilterExpression: filterFor(spec.when),
    });
  } catch (err) {
    // The rebuild can only fail on data that genuinely breaks the rule — two
    // rows sharing a real SKU, say. Put back what was there rather than leave
    // the collection with no guard at all, and let the error travel.
    if (current) {
      const { v, name, key, ...options } = current;
      await collection.createIndex(key, { name, ...options }).catch(() => {});
    }
    throw err;
  }
  return current ? 'replaced' : 'created';
}

async function repairIndexes(connection = mongoose.connection) {
  require('../models'); // registers the models these specs are named after

  const done = [];
  for (const spec of EXPECTED) {
    try {
      const outcome = await repairIndex(connection, spec);
      done.push({ ...spec, outcome });
      if (outcome === 'replaced' || outcome === 'created') {
        console.log(`🔧 ${spec.model}.${spec.name} ${outcome} — unique only where ${spec.when} is set`);
      }
    } catch (err) {
      // A real clash — two rows genuinely sharing a value — is the tenant's to
      // sort out, and is no reason to refuse to start.
      done.push({ ...spec, outcome: 'failed', error: err.message });
      console.error(`⚠️  ${spec.model}.${spec.name} could not be rebuilt: ${err.message}`);
    }
  }
  return done;
}

module.exports = { repairIndexes, EXPECTED, filterFor, isRight };

// Also runnable on its own: npm run db:fix-indexes
if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/gthink_erp');
    const done = await repairIndexes();
    for (const d of done) console.log(`${d.model}.${d.name}: ${d.outcome}`);
    await mongoose.disconnect();
    process.exit(done.some((d) => d.outcome === 'failed') ? 1 : 0);
  })();
}
