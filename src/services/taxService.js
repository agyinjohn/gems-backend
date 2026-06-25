const { TaxRate } = require('../models');

async function getActiveSalesTaxRate(tenantId) {
  return TaxRate.findOne({
    tenant_id: tenantId,
    is_active: true,
    applies_to: { $in: ['sales', 'both'] },
  }).sort({ createdAt: -1 });
}

function calcTaxAmount(subtotal, ratePct = 0) {
  if (!subtotal || !ratePct) return 0;
  return Math.round(subtotal * ratePct) / 100;
}

module.exports = { getActiveSalesTaxRate, calcTaxAmount };
