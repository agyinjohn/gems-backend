const mongoose = require('mongoose');

/**
 * Branch scoping.
 *
 * The system encodes org-level vs branch-level access on the user record via
 * `branch_id`:
 *   - branch_id === null  → organizational / company-wide (e.g. business owner)
 *   - branch_id is set     → locked to that branch
 *
 * This middleware resolves an authoritative branch filter and exposes it on the
 * request so list/aggregate controllers can scope their queries consistently —
 * the same way `req.tenant_id` is used for tenant scoping.
 *
 * Contract (set on every authenticated, tenant-bound request):
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
 */
const resolveBranchScope = (req, res, next) => {
  const userBranchId = req.user?.branch_id || null;

  if (userBranchId) {
    // Branch-bound user — pinned, query param ignored.
    req.isOrgLevel = false;
    req.branchId = userBranchId;
    req.branchFilter = { branch_id: userBranchId };
    return next();
  }

  // Organizational-level user — may pick a branch or view all.
  req.isOrgLevel = true;
  const requested = req.query.branch_id;
  if (requested && mongoose.Types.ObjectId.isValid(requested)) {
    req.branchId = new mongoose.Types.ObjectId(requested);
    req.branchFilter = { branch_id: req.branchId };
  } else {
    req.branchId = null;
    req.branchFilter = {};
  }
  return next();
};

module.exports = { resolveBranchScope };
