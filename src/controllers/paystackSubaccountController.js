const { Tenant } = require('../models');
const { paystackRequest, getPaystackCredentials } = require('../services/paymentService');

/**
 * Paystack subaccount — opts a tenant into gateway-level payment splitting.
 *
 * Once connected, their share of each storefront payment settles directly to
 * the bank account registered here, on Paystack's settlement schedule, and the
 * platform balance / manual withdrawal flow no longer applies to those orders.
 */

const get = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id).select('paystack_subaccount').lean();
  const sub = tenant?.paystack_subaccount;
  res.json({
    success: true,
    data: sub?.subaccount_code
      ? {
          subaccount_code: sub.subaccount_code,
          account_name: sub.account_name,
          account_number: sub.account_number,
          bank_code: sub.bank_code,
          is_active: sub.is_active !== false,
          connected_at: sub.connected_at,
        }
      : null,
  });
};

const connect = async (req, res) => {
  const { business_name, settlement_bank, account_number } = req.body;
  if (!business_name || !settlement_bank || !account_number) {
    return res.status(400).json({
      success: false,
      message: 'business_name, settlement_bank and account_number are required.',
    });
  }

  const { secretKey } = await getPaystackCredentials();

  // percentage_charge is the platform's share. Zero here so a plain storefront
  // sale goes wholly to the tenant; the marketplace commission is applied per
  // transaction instead, via transaction_charge.
  const result = await paystackRequest({
    method: 'POST',
    path: '/subaccount',
    body: {
      business_name,
      settlement_bank,
      account_number,
      percentage_charge: 0,
      currency: 'GHS',
    },
    secretKey,
  });

  if (!result.status) {
    return res.status(400).json({
      success: false,
      message: result.message || 'Paystack could not create the subaccount. Check the bank and account number.',
    });
  }

  await Tenant.findByIdAndUpdate(req.tenant_id, {
    $set: {
      paystack_subaccount: {
        subaccount_code: result.data.subaccount_code,
        account_number: result.data.account_number || account_number,
        account_name: result.data.account_name || business_name,
        bank_code: settlement_bank,
        is_active: true,
        connected_at: new Date(),
      },
    },
  });

  res.status(201).json({
    success: true,
    data: {
      subaccount_code: result.data.subaccount_code,
      account_name: result.data.account_name || business_name,
      account_number: result.data.account_number || account_number,
      bank_code: settlement_bank,
      is_active: true,
    },
  });
};

/**
 * Stop splitting. Payments collect into the platform balance again from the
 * next order; anything already settled directly stays with the tenant and is
 * never added back to the withdrawable balance.
 */
const disconnect = async (req, res) => {
  await Tenant.findByIdAndUpdate(req.tenant_id, {
    $set: { 'paystack_subaccount.is_active': false },
  });
  res.json({ success: true });
};

/** Banks Paystack can settle to, for the connect form. */
const listBanks = async (req, res) => {
  const { secretKey } = await getPaystackCredentials();
  const result = await paystackRequest({
    method: 'GET',
    path: '/bank?currency=GHS',
    secretKey,
  });
  if (!result.status) {
    return res.status(400).json({ success: false, message: result.message || 'Could not load banks.' });
  }
  res.json({
    success: true,
    data: (result.data || []).map((b) => ({ name: b.name, code: b.code, type: b.type })),
  });
};

module.exports = { get, connect, disconnect, listBanks };
