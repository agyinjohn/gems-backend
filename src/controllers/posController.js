const { PosShift, Order, Tenant } = require('../models');
const { resolveWriteBranchId } = require('../middleware/branchScope');
const { getOpenShift, fulfillPosPaystackOrder, requireOpenShift } = require('../services/posService');
const { buildZReport, listShifts, getShiftDetail } = require('../services/posShiftService');
const {
  getPaystackCredentials,
  assertPaystackConfigured,
  resolvePaystackEmail,
  initializePaystackTransaction,
} = require('../services/paymentService');
const {
  resolveVirtualTerminalCode,
  getVirtualTerminalPayUrl,
  fetchVirtualTerminal,
} = require('../services/virtualTerminalService');
const {
  publishCustomerDisplay,
  getCustomerDisplay,
  clearCustomerDisplay,
  showOrderOnDisplay,
  listPendingPaystackOrders,
  cancelPendingPaystackOrder,
  getDisplayQueue,
} = require('../services/posDisplayService');
const { syncPendingPaystackOrders, PENDING_ORDER_TTL_MS } = require('../services/posPendingService');
const splitService = require('../services/splitService');
const {
  reserveStockForItems,
  releaseStockForItems,
  availableQty,
} = require('../services/posReservationService');

const openShift = async (req, res) => {
  const branchId = await resolveWriteBranchId(req);
  const existing = await getOpenShift(req.tenant_id, req.user._id, branchId);
  if (existing) return res.status(400).json({ success: false, message: 'You already have an open shift on this branch.', data: existing });

  const openingFloat = parseFloat(req.body.opening_float) || 0;
  const cashierName = String(req.body.cashier_name || '').trim() || req.user.name || req.user.email || 'Cashier';

  const shift = await PosShift.create({
    tenant_id: req.tenant_id,
    branch_id: branchId,
    opened_by: req.user._id,
    cashier_name: cashierName,
    shift_number: `SHIFT-${Date.now()}`,
    opening_float: openingFloat,
    expected_cash: openingFloat,
    status: 'open',
  });
  res.status(201).json({ success: true, data: shift });
};

const getCurrentShift = async (req, res) => {
  const shift = await getOpenShift(req.tenant_id, req.user._id, await resolveWriteBranchId(req));
  if (!shift) return res.json({ success: true, data: null });
  const data = shift.toObject();
  if (!data.cashier_name) {
    data.cashier_name = req.user.name || req.user.email || 'Cashier';
  }
  res.json({ success: true, data });
};

const closeShift = async (req, res) => {
  const shift = await getOpenShift(req.tenant_id, req.user._id, await resolveWriteBranchId(req));
  if (!shift) return res.status(404).json({ success: false, message: 'No open shift found.' });

  const actual_cash = parseFloat(req.body.actual_cash);
  if (Number.isNaN(actual_cash)) return res.status(400).json({ success: false, message: 'actual_cash required.' });

  const expected = shift.expected_cash ?? shift.opening_float;
  shift.status = 'closed';
  shift.closed_at = new Date();
  shift.closed_by = req.user._id;
  shift.actual_cash = actual_cash;
  shift.cash_variance = actual_cash - expected;
  shift.notes = req.body.notes || '';
  await shift.save();

  res.json({
    success: true,
    message: 'Shift closed.',
    data: {
      ...shift.toJSON(),
      z_report: buildZReport(shift),
    },
  });
};

const listShiftHistory = async (req, res) => {
  const data = await listShifts(req.tenant_id, req.user, req.query, req.branchFilter);
  res.json({ success: true, ...data });
};

const getShiftHistoryDetail = async (req, res) => {
  const data = await getShiftDetail(req.tenant_id, req.user, req.params.id);
  if (!data) return res.status(404).json({ success: false, message: 'Shift not found.' });
  res.json({ success: true, data });
};

const getZReport = async (req, res) => {
  const shift = await PosShift.findOne({ _id: req.params.id, tenant_id: req.tenant_id });
  if (!shift) return res.status(404).json({ success: false, message: 'Shift not found.' });
  res.json({ success: true, data: buildZReport(shift) });
};

const initPaystackPayment = async (req, res) => {
  const { items, customer_name, customer_phone, payment_method } = req.body;
  if (!items?.length) return res.status(400).json({ success: false, message: 'items required.' });

  let shift;
  try {
    shift = await requireOpenShift(req.tenant_id, req.user._id, await resolveWriteBranchId(req));
  } catch (err) {
    return res.status(err.status || 403).json({ success: false, message: err.message });
  }

  const tenant = await Tenant.findById(req.tenant_id);

  let subtotal = 0;
  const enrichedItems = [];
  for (const item of items) {
    const { Product } = require('../models');
    const p = await Product.findOne({ _id: item.product_id, tenant_id: req.tenant_id, is_active: true });
    if (!p) return res.status(400).json({ success: false, message: 'Product not found.' });
    if (availableQty(p) < item.quantity) return res.status(400).json({ success: false, message: `Insufficient stock for ${p.name}.` });
    const total = p.price * item.quantity;
    subtotal += total;
    enrichedItems.push({ product_id: p._id, product_name: p.name, quantity: item.quantity, unit_price: p.price, total });
  }

  const reference = `POS-PAY-${Date.now()}`;
  const paystackEmail = await resolvePaystackEmail({
    customerEmail: req.body.customer_email,
    staffEmail: req.user.email,
    tenantEmail: tenant?.email,
    reference,
  });
  const channels = payment_method === 'card'
    ? ['card']
    : payment_method === 'card_terminal'
      ? ['card', 'mobile_money']
      : ['mobile_money'];

  if (!subtotal || subtotal <= 0) {
    return res.status(400).json({ success: false, message: 'Cart total must be greater than zero.' });
  }

  let credentials;
  try {
    credentials = await getPaystackCredentials();
    assertPaystackConfigured(credentials);
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ success: false, message: err.message || 'Paystack is not configured.' });
  }

  const orderNumber = `POS-${Date.now()}-${Math.floor(Math.random() * 100)}`;
  const order = await Order.create({
    tenant_id: req.tenant_id,
    branch_id: await resolveWriteBranchId(req),
    shift_id: shift._id,
    order_number: orderNumber,
    customer_name: customer_name || 'Walk-in Customer',
    customer_phone: customer_phone || '',
    subtotal,
    total: subtotal,
    payment_status: 'pending',
    payment_method: payment_method === 'card' ? 'card' : payment_method === 'card_terminal' ? 'card_terminal' : 'momo',
    payment_ref: reference,
    pending_expires_at: new Date(Date.now() + PENDING_ORDER_TTL_MS),
    status: 'pending',
    source: 'pos',
    items: enrichedItems,
    created_by: req.user._id,
  });

  try {
    await reserveStockForItems({
      tenantId: req.tenant_id,
      items: enrichedItems.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
    });
  } catch (err) {
    await Order.findByIdAndDelete(order._id);
    return res.status(err.status || 400).json({ success: false, message: err.message || 'Could not reserve stock.' });
  }

  const rollbackPending = async () => {
    await releaseStockForItems({
      tenantId: req.tenant_id,
      items: enrichedItems.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
    });
    await Order.findByIdAndDelete(order._id);
  };

  // Split-enabled tenants are settled at the gateway on POS sales too. A POS
  // sale is never a marketplace order, so the tenant keeps the whole amount and
  // the platform takes nothing (a charge of 0). Resolved before the branch
  // below because both the server-initialised (card) and popup (momo) paths
  // need it.
  const posSplit = await splitService.buildSplitForCheckout({
    tenantId: req.tenant_id,
    amount: subtotal,
    viaMarketplace: false,
  });
  if (posSplit) {
    order.split_settled = true;
    order.subaccount_code = posSplit.subaccount;
    await order.save();
  }

  const basePayload = {
    order_id: order._id,
    order_number: orderNumber,
    reference,
    amount: subtotal,
    email: paystackEmail,
    paystack_public_key: credentials.publicKey,
    channels,
    ...(posSplit && { subaccount: posSplit.subaccount, transaction_charge: posSplit.transaction_charge }),
  };

  if (payment_method === 'card' || payment_method === 'card_terminal') {
    try {
      const initChannels = payment_method === 'card' ? ['card'] : ['card', 'mobile_money'];
      const metadata = {
        pos_order_id: String(order._id),
        order_number: orderNumber,
        custom_fields: [
          { display_name: 'POS Order', variable_name: 'order_number', value: orderNumber },
        ],
      };

      if (payment_method === 'card_terminal') {
        const vtCode = await resolveVirtualTerminalCode();
        if (!vtCode) {
          await rollbackPending();
          return res.status(500).json({
            success: false,
            message: 'Paystack Virtual Terminal is not configured. Add VT code in Platform Settings → Payment Gateway.',
          });
        }
        metadata.virtual_terminal = { code: vtCode };
      }

      const paystackInit = await initializePaystackTransaction({
        email: paystackEmail,
        amount: subtotal,
        reference,
        channels: initChannels,
        metadata,
        ...(posSplit && { subaccount: posSplit.subaccount, transaction_charge: posSplit.transaction_charge }),
      });

      let terminalName = null;
      if (payment_method === 'card_terminal') {
        try {
          const vt = await fetchVirtualTerminal(metadata.virtual_terminal.code);
          terminalName = vt?.name || null;
        } catch { /* optional */ }
      }

      order.paystack_checkout_url = paystackInit.authorization_url;
      await order.save();

      await publishCustomerDisplay({
        tenantId: req.tenant_id,
        branchId: await resolveWriteBranchId(req),
        orderId: order._id,
        orderNumber: orderNumber,
        customerName: order.customer_name,
        amount: subtotal,
        authorizationUrl: paystackInit.authorization_url,
        reference,
        paymentMethod: order.payment_method,
        publishedBy: req.user._id,
      });

      return res.json({
        success: true,
        data: {
          ...basePayload,
          channels: initChannels,
          payment_mode: payment_method === 'card_terminal' ? 'vt_qr' : 'qr',
          authorization_url: paystackInit.authorization_url,
          virtual_terminal_code: metadata.virtual_terminal?.code || null,
          virtual_terminal_name: terminalName,
          static_terminal_url: metadata.virtual_terminal?.code
            ? getVirtualTerminalPayUrl(metadata.virtual_terminal.code)
            : null,
          expires_at: order.pending_expires_at,
        },
      });
    } catch (err) {
      await rollbackPending();
      const status = err.status || 500;
      return res.status(status).json({ success: false, message: err.message || 'Could not start card payment.' });
    }
  }

  res.json({
    success: true,
    data: {
      ...basePayload,
      payment_mode: 'popup',
      expires_at: order.pending_expires_at,
    },
  });
};

const getVirtualTerminalInfo = async (req, res) => {
  try {
    const credentials = await getPaystackCredentials();
    assertPaystackConfigured(credentials);
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message });
  }

  const code = await resolveVirtualTerminalCode();
  if (!code) {
    return res.json({
      success: true,
      data: { configured: false, message: 'Set paystack_virtual_terminal_code in Platform Settings.' },
    });
  }

  try {
    const vt = await fetchVirtualTerminal(code);
    return res.json({
      success: true,
      data: {
        configured: true,
        code: vt.code || code,
        name: vt.name,
        active: vt.active,
        payment_page_url: getVirtualTerminalPayUrl(vt.code || code),
      },
    });
  } catch {
    return res.json({
      success: true,
      data: {
        configured: true,
        code,
        name: code,
        payment_page_url: getVirtualTerminalPayUrl(code),
      },
    });
  }
};

const getCustomerDisplaySession = async (req, res) => {
  const session = await getCustomerDisplay({
    tenantId: req.tenant_id,
    branchId: await resolveWriteBranchId(req),
  });

  if (!session) {
    return res.json({ success: true, data: null });
  }

  res.json({
    success: true,
    data: {
      order_id: String(session.order_id),
      order_number: session.order_number,
      customer_name: session.customer_name,
      amount: session.amount,
      authorization_url: session.authorization_url,
      reference: session.reference,
      payment_method: session.payment_method,
      published_at: session.published_at,
    },
  });
};

const publishDisplayOrder = async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ success: false, message: 'order_id required.' });

  try {
    const session = await showOrderOnDisplay({
      tenantId: req.tenant_id,
      branchId: await resolveWriteBranchId(req),
      orderId: order_id,
      userId: req.user._id,
    });
    res.json({
      success: true,
      data: {
        order_id: String(session.order_id),
        authorization_url: session.authorization_url,
        amount: session.amount,
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message || 'Could not show on display.' });
  }
};

const clearDisplaySession = async (req, res) => {
  await clearCustomerDisplay({
    tenantId: req.tenant_id,
    branchId: await resolveWriteBranchId(req),
  });
  res.json({ success: true, message: 'Customer display cleared.' });
};

const getPendingPaystackOrders = async (req, res) => {
  const shift = await getOpenShift(req.tenant_id, req.user._id, await resolveWriteBranchId(req));
  const { pending, events } = await syncPendingPaystackOrders({
    tenantId: req.tenant_id,
    userId: req.user._id,
    branchId: await resolveWriteBranchId(req),
    shiftId: shift?._id,
  });
  res.json({ success: true, data: pending, events });
};

const getDisplayQueueSession = async (req, res) => {
  const { queue, paid_flash } = await getDisplayQueue({
    tenantId: req.tenant_id,
    branchId: await resolveWriteBranchId(req),
  });
  res.json({ success: true, data: queue, paid_flash });
};

const cancelPaystackPending = async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ success: false, message: 'order_id required.' });

  try {
    const result = await cancelPendingPaystackOrder({ tenantId: req.tenant_id, orderId: order_id });
    res.json({ success: true, message: `Cancelled ${result.order_number}.`, data: result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message || 'Could not cancel.' });
  }
};

const verifyPaystackPayment = async (req, res) => {
  const { reference, order_id, amount_tendered } = req.body;
  if (!reference || !order_id) return res.status(400).json({ success: false, message: 'reference and order_id required.' });

  try {
    const result = await fulfillPosPaystackOrder({
      tenantId: req.tenant_id,
      orderId: order_id,
      reference,
      userId: req.user._id,
      branchId: await resolveWriteBranchId(req),
      amount_tendered,
    });
    res.json({
      success: true,
      already_fulfilled: !!result.already_fulfilled,
      data: { ...result.order.toJSON(), change: result.change, amount_tendered: result.amount_tendered },
    });
  } catch (err) {
    const status = err.status || (err.message?.includes('not configured') ? 500 : 400);
    res.status(status).json({ success: false, message: err.message || 'Payment verification failed.' });
  }
};

module.exports = {
  openShift,
  getCurrentShift,
  closeShift,
  listShiftHistory,
  getShiftHistoryDetail,
  getZReport,
  initPaystackPayment,
  verifyPaystackPayment,
  getVirtualTerminalInfo,
  getCustomerDisplaySession,
  publishDisplayOrder,
  clearDisplaySession,
  getPendingPaystackOrders,
  cancelPaystackPending,
  getDisplayQueueSession,
};
