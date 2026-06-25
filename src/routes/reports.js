const express = require('express');
const router = express.Router();
const { authenticate, requireTenant } = require('../middleware/auth');
const { requireFeature } = require('../middleware/featureFlags');
const reports = require('../controllers/reportsController');

router.use(authenticate, requireTenant, requireFeature('reports'));

router.get('/reports/branches', reports.getBranches);
router.get('/reports/overview', reports.getOverview);
router.get('/reports/sales', reports.getSales);
router.get('/reports/inventory', reports.getInventory);
router.get('/reports/finance', reports.getFinance);
router.get('/reports/hr', reports.getHr);
router.get('/reports/procurement', reports.getProcurement);
router.get('/reports/crm', reports.getCrm);

module.exports = router;
