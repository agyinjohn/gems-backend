const { PaymentLog } = require('../models');

/**
 * Log a payment event anywhere in the app.
 * @param {object} data
 * @param {string} data.source        - storefront | pos | internal_order | purchase_order | payroll | subscription
 * @param {string} data.reference     - order number, PO number, paystack ref, etc.
 * @param {number} data.amount
 * @param {string} [data.currency]    - defaults to GHS
 * @param {string} [data.method]      - paystack | cash | mobile_money | bank_transfer | card | manual
 * @param {string} [data.status]      - success | failed | pending | refunded
 * @param {*}      [data.tenant_id]
 * @param {string} [data.payer_name]
 * @param {string} [data.payer_email]
 * @param {string} [data.description]
 * @param {*}      [data.source_id]   - ObjectId of the related document
 * @param {*}      [data.recorded_by] - user ObjectId
 */
const logPayment = async (data) => {
  try {
    await PaymentLog.create(data);
  } catch (err) {
    console.error('[PaymentLog] Failed to log payment:', err.message);
  }
};

module.exports = logPayment;
