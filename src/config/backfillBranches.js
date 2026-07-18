/**
 * One-off backfill: assign existing branch-less business records to each
 * tenant's HQ / Main branch.
 *
 * Records created by organizational-level users (e.g. the business owner, who
 * has branch_id = null) were stored with branch_id = null and therefore never
 * appear under a specific-branch filter. This reassigns those null-branch rows
 * to the tenant's HQ / Main branch so they become visible and filterable.
 *
 * Safe to re-run: it only ever touches rows where branch_id is null.
 * People (User, Employee) are intentionally excluded — a null branch there
 * means "company-wide", which is legitimate.
 *
 *   Run with: npm run db:backfill-branches
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./db');
const {
  Tenant, Branch,
  Product, StockMovement, Order, PurchaseOrder, Expense, Asset, Customer, Lead, ContactHistory,
} = require('../models');

// Collections to backfill (all carry branch_id; excludes User/Employee).
const MODELS = [
  ['Product', Product],
  ['StockMovement', StockMovement],
  ['Order', Order],
  ['PurchaseOrder', PurchaseOrder],
  ['Expense', Expense],
  ['Asset', Asset],
  ['Customer', Customer],
  ['Lead', Lead],
  ['ContactHistory', ContactHistory],
];

async function run() {
  await connectDB();

  const tenants = await Tenant.find({}, '_id business_name');
  console.log(`\nBackfilling branch_id for ${tenants.length} tenant(s)…\n`);

  let grandTotal = 0;

  for (const tenant of tenants) {
    // HQ / Main branch fallback: prefer slug 'main', else the oldest branch.
    const hq = await Branch.findOne({ tenant_id: tenant._id, slug: 'main' })
      || await Branch.findOne({ tenant_id: tenant._id }).sort({ createdAt: 1 });

    if (!hq) {
      console.log(`⚠️  ${tenant.business_name} — no branch found, skipping.`);
      continue;
    }

    let tenantTotal = 0;
    const parts = [];
    for (const [name, Model] of MODELS) {
      const res = await Model.updateMany(
        { tenant_id: tenant._id, branch_id: null },
        { $set: { branch_id: hq._id } },
      );
      const n = res.modifiedCount ?? res.nModified ?? 0;
      if (n > 0) parts.push(`${name}: ${n}`);
      tenantTotal += n;
    }

    grandTotal += tenantTotal;
    console.log(
      `• ${tenant.business_name} → ${hq.name} (${hq._id}) — ${tenantTotal} row(s)` +
      (parts.length ? ` [${parts.join(', ')}]` : ' [nothing to backfill]'),
    );
  }

  console.log(`\n✅ Done. Reassigned ${grandTotal} row(s) in total.\n`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  console.error('❌ Backfill failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
