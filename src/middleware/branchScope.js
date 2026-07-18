const mongoose = require('mongoose');

/**
 * Branch scoping.
 *
 * The system encodes org-level vs branch-level access on the user record via
 * `branch_id`:
 *   - branch_id === null  → organizational / company-wide (e.g. business owner)
 *   - branch_id is set     → locked to that branch
 *
 * This resolves an authoritative branch filter and exposes it on the request so
 * list/aggregate controllers can scope their queries consistently — the same
 * way `req.tenant_id` is used for tenant scoping.
 *
 * Contract (set on every authenticated request):
 *   req.isOrgLevel    boolean  — true when the user is not bound to a branch
 *   req.branchId      ObjectId|null — the effective single branch, or null for "all"
 *   req.branchFilter  object   — spread into Mongo queries: {} = all branches,
 *                                { branch_id } = a single branch
 *
 * Rules:
 *   - Branch-level users are ALWAYS pinned to their own branch. Any incoming
 *     ?branch_id query param is ignored — they cannot widen their scope.
 *   - Org-level users honor ?branch_id when it is a valid id, otherwise they
 *     see all branches ({}).
 *
 * IMPORTANT: this must run AFTER authentication (req.user must be populated).
 * It is applied from the end of the `authenticate` middleware rather than as a
 * standalone router-level middleware, because per-route `authenticate` runs
 * after any router.use() middleware — so a router.use() here would see no user.
 */
function computeBranchScope(user, query = {}) {
  const userBranchId = user?.branch_id || null;

  if (userBranchId) {
    // Branch-bound user — pinned, query param ignored.
    return { isOrgLevel: false, branchId: userBranchId, branchFilter: { branch_id: userBranchId } };
  }

  // Organizational-level user — may pick a branch or view all.
  const requested = query.branch_id;
  if (requested && mongoose.Types.ObjectId.isValid(requested)) {
    const branchId = new mongoose.Types.ObjectId(requested);
    return { isOrgLevel: true, branchId, branchFilter: { branch_id: branchId } };
  }
  return { isOrgLevel: true, branchId: null, branchFilter: {} };
}

/** Attach the resolved branch scope onto the request. */
function applyBranchScope(req) {
  const { isOrgLevel, branchId, branchFilter } = computeBranchScope(req.user, req.query);
  req.isOrgLevel = isOrgLevel;
  req.branchId = branchId;
  req.branchFilter = branchFilter;
}

/** Express middleware form (only valid when placed after authentication). */
const resolveBranchScope = (req, res, next) => {
  applyBranchScope(req);
  next();
};

/**
 * Resolve which branch a newly-created record should belong to, so org-level
 * users' writes are branch-filterable instead of landing as company-wide null.
 *
 *   - Branch-level user             → their own branch.
 *   - Org-level user, branch chosen → the selected branch (req.branchId).
 *   - Org-level user, "all" chosen  → the tenant's HQ / Main branch fallback.
 *
 * Returns null only if the tenant somehow has no branch at all.
 */
async function resolveWriteBranchId(req) {
  if (req.user?.branch_id) return req.user.branch_id;   // branch-level: pinned
  if (req.branchId) return req.branchId;                // org-level: active selection

  // Org-level with "all branches" selected — fall back to HQ / Main.
  const { Branch } = require('../models');
  const hq = await Branch.findOne({ tenant_id: req.tenant_id, slug: 'main' })
    || await Branch.findOne({ tenant_id: req.tenant_id }).sort({ createdAt: 1 });
  return hq?._id || null;
}

module.exports = { resolveBranchScope, applyBranchScope, computeBranchScope, resolveWriteBranchId };
