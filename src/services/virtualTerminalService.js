const { getPaystackCredentials, paystackRequest } = require('./paymentService');

async function resolveVirtualTerminalCode() {
  const { PlatformSettings } = require('../models');
  const settings = await PlatformSettings.findOne().lean();
  return (settings?.paystack_virtual_terminal_code || process.env.PAYSTACK_VIRTUAL_TERMINAL_CODE || '').trim();
}

function getVirtualTerminalPayUrl(code) {
  if (!code) return '';
  return `https://paystack.shop/pay/${code.toLowerCase()}`;
}

async function listVirtualTerminals({ perPage = 50 } = {}) {
  const { secretKey } = await getPaystackCredentials();
  const parsed = await paystackRequest({
    method: 'GET',
    path: `/virtual_terminal?perPage=${perPage}`,
    secretKey,
  });
  return parsed.data || [];
}

async function fetchVirtualTerminal(code) {
  const { secretKey } = await getPaystackCredentials();
  const parsed = await paystackRequest({
    method: 'GET',
    path: `/virtual_terminal/${encodeURIComponent(code)}`,
    secretKey,
  });
  return parsed.data;
}

async function createVirtualTerminal({ name, destinations, currency = 'GHS' }) {
  const { secretKey } = await getPaystackCredentials();
  const parsed = await paystackRequest({
    method: 'POST',
    path: '/virtual_terminal',
    secretKey,
    body: { name, destinations, currency },
  });
  return parsed.data;
}

module.exports = {
  resolveVirtualTerminalCode,
  getVirtualTerminalPayUrl,
  listVirtualTerminals,
  fetchVirtualTerminal,
  createVirtualTerminal,
};
