const { PayoutMethod } = require('../models');
const { paystackRequest, getPaystackCredentials } = require('../services/paymentService');

// GHS mobile money network codes (Paystack)
const MOMO_NETWORKS = {
  mtn: 'MTN',
  vodafone: 'VOD',
  airteltigo: 'ATL',
};

const list = async (req, res) => {
  const methods = await PayoutMethod.find({ tenant_id: req.user.tenant_id, is_active: true }).sort({ is_default: -1, createdAt: -1 }).lean();
  res.json({ success: true, data: methods });
};

const create = async (req, res) => {
  const { type, account_number, account_name, bank_code } = req.body;
  if (!type || !account_number || !account_name || !bank_code) {
    return res.status(400).json({ success: false, message: 'type, account_number, account_name and bank_code are required.' });
  }

  const { secretKey } = await getPaystackCredentials();

  // Create Paystack transfer recipient
  const recipientPayload = {
    type: type === 'mobile_money' ? 'mobile_money' : 'ghipss',
    name: account_name,
    account_number,
    bank_code,
    currency: 'GHS',
  };

  const result = await paystackRequest({ method: 'POST', path: '/transferrecipient', body: recipientPayload, secretKey });
  if (!result.status) {
    return res.status(400).json({ success: false, message: result.message || 'Failed to create Paystack recipient.' });
  }

  const recipient_code = result.data.recipient_code;
  const networkLabel = type === 'mobile_money'
    ? (Object.entries(MOMO_NETWORKS).find(([, v]) => v === bank_code)?.[0]?.toUpperCase() || bank_code)
    : bank_code;
  const label = `${networkLabel} — ${account_number.slice(-4).padStart(account_number.length, '*')}`;

  // If first method, make it default
  const existingCount = await PayoutMethod.countDocuments({ tenant_id: req.user.tenant_id, is_active: true });

  const method = await PayoutMethod.create({
    tenant_id: req.user.tenant_id,
    type,
    label,
    recipient_code,
    account_number,
    account_name,
    bank_code,
    is_default: existingCount === 0,
  });

  res.status(201).json({ success: true, data: method });
};

const setDefault = async (req, res) => {
  const { id } = req.params;
  await PayoutMethod.updateMany({ tenant_id: req.user.tenant_id }, { is_default: false });
  const method = await PayoutMethod.findOneAndUpdate(
    { _id: id, tenant_id: req.user.tenant_id },
    { is_default: true },
    { new: true },
  );
  if (!method) return res.status(404).json({ success: false, message: 'Payout method not found.' });
  res.json({ success: true, data: method });
};

const remove = async (req, res) => {
  const { id } = req.params;
  const method = await PayoutMethod.findOneAndUpdate(
    { _id: id, tenant_id: req.user.tenant_id },
    { is_active: false },
    { new: true },
  );
  if (!method) return res.status(404).json({ success: false, message: 'Payout method not found.' });

  // If deleted method was default, promote the next one
  if (method.is_default) {
    const next = await PayoutMethod.findOne({ tenant_id: req.user.tenant_id, is_active: true }).sort({ createdAt: -1 });
    if (next) await PayoutMethod.findByIdAndUpdate(next._id, { is_default: true });
  }

  res.json({ success: true });
};

module.exports = { list, create, setDefault, remove };
