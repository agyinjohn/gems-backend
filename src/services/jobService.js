const { Job } = require('../models');

/**
 * Turning an accepted request into work.
 *
 * A service request and a job are the same work seen from two sides. The
 * request is the client's: they hold its tracking link, they see the stages,
 * they accept the quote and pay against it. The job is the shop's: who is doing
 * it, what it costs, when it is invoiced.
 *
 * Before this, accepting a quote produced nothing internal, so somebody read
 * the request and typed a job by hand. That is the same work entered twice, and
 * nothing recorded that the two rows were about one thing — which is why
 * "how many requests turned into paid work" had no answer.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * The next JOB-0001 for a tenant.
 *
 * Derived from the highest existing number rather than a count, so deleting a
 * job doesn't hand its code to the next one.
 */
async function nextJobCode(tenantId) {
  const last = await Job.find({ tenant_id: tenantId }).sort({ createdAt: -1 }).limit(1).select('code').lean();
  const seq = last[0]?.code ? (parseInt(last[0].code.replace(/\D/g, ''), 10) || 0) + 1 : 1;
  return `JOB-${String(seq).padStart(4, '0')}`;
}

/** A line of the job, described the way the client asked for it. */
function jobLines(items = []) {
  return items.map((item) => ({
    description: [item.product_name, item.spec].filter(Boolean).join(' — '),
    quantity: item.quantity || 1,
    unit_price: round2(item.unit_price),
    total: round2(item.total),
  }));
}

/** Something a person can read on a job board, not a reference number. */
function jobTitle(order) {
  const items = order.items || [];
  if (!items.length) return `Service request ${order.order_number}`;
  const first = items[0].product_name || 'Work';
  return items.length === 1 ? first : `${first} +${items.length - 1} more`;
}

/**
 * Create the job an accepted request became.
 *
 * Idempotent on the request: a request that already has a job returns it rather
 * than making a second one. Accepting is guarded upstream too, but this is the
 * cheaper place to be certain, since a duplicate job is real work someone would
 * have to notice and delete.
 *
 * The client has no account, so there is no user to record as the creator and
 * `created_by` is left unset — the request itself is the provenance.
 */
async function createFromServiceRequest(order) {
  if (order.job_id) {
    const existing = await Job.findById(order.job_id);
    if (existing) return existing;
  }

  const base = {
    tenant_id: order.tenant_id,
    branch_id: order.branch_id || undefined,
    title: jobTitle(order),
    description: order.notes || undefined,
    // Intake takes a name and a phone, not a CRM record, so the job carries
    // them as a walk-in. Where the request did come from a known customer, that
    // link is kept as well.
    customer_id: order.customer_id || undefined,
    walk_in_name: order.customer_name || undefined,
    walk_in_phone: order.customer_phone || undefined,
    job_type: order.service_type || 'general',
    items: jobLines(order.items),
    status: 'open',
    service_request_id: order._id,
  };

  // The code is derived from the current highest, so two requests accepted at
  // the same instant can pick the same one. The unique index catches that;
  // retrying reads a number that now includes the winner.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await Job.create({ ...base, code: await nextJobCode(order.tenant_id) });
    } catch (err) {
      const duplicateCode = err?.code === 11000 && JSON.stringify(err.keyPattern || {}).includes('code');
      if (!duplicateCode || attempt === 4) throw err;
    }
  }
  return null;
}

module.exports = {
  nextJobCode,
  jobLines,
  jobTitle,
  createFromServiceRequest,
};
