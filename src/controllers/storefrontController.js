const mongoose = require('mongoose');
const { Tenant, Order } = require('../models');
const { getActiveSalesTaxRate, calcTaxAmount } = require('../services/taxService');

const DEFAULTS = {
  delivery_fee: 30,
  free_delivery_threshold: 500,
  store_enabled: true,
  announcement: '',
  min_order_amount: 0,
  custom_domain: '',
  brand_color: '',
  banner_image: '',
  tagline: '',
  hero_headline: '',
};

/** How long a hero line may be before it stops being a hero line. */
const HEADLINE_MAX = 70;
const TAGLINE_MAX = 160;

/**
 * A colour a browser will accept, or nothing.
 *
 * Whatever a shop owner types ends up in a stylesheet, so it is checked rather
 * than trusted: a six-digit hex and nothing else. Anything odd falls back to
 * the GEMS navy, which is what every storefront looked like anyway.
 */
function safeHex(value) {
  const hex = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : '';
}

/** A URL for an image, or nothing. Same reasoning: it is going into a page. */
function safeImageUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : '';
}

function pickSettings(tenant) {
  const raw = tenant.storefront_settings?.toObject?.() || tenant.storefront_settings || {};
  return {
    delivery_fee: Number(raw.delivery_fee ?? DEFAULTS.delivery_fee),
    free_delivery_threshold: Number(raw.free_delivery_threshold ?? DEFAULTS.free_delivery_threshold),
    store_enabled: raw.store_enabled ?? DEFAULTS.store_enabled,
    announcement: raw.announcement ?? DEFAULTS.announcement,
    min_order_amount: Number(raw.min_order_amount ?? DEFAULTS.min_order_amount),
    custom_domain: String(raw.custom_domain ?? DEFAULTS.custom_domain).toLowerCase().trim(),
    brand_color: safeHex(raw.brand_color),
    banner_image: safeImageUrl(raw.banner_image),
    tagline: String(raw.tagline ?? DEFAULTS.tagline).slice(0, TAGLINE_MAX),
    hero_headline: String(raw.hero_headline ?? DEFAULTS.hero_headline).slice(0, HEADLINE_MAX),
  };
}

function calcDeliveryFee(subtotal, settings) {
  if (subtotal <= 0) return 0;
  return subtotal >= settings.free_delivery_threshold ? 0 : settings.delivery_fee;
}

function formatOrderForTrack(order) {
  const data = order.toObject();
  data.created_at = data.createdAt;
  return data;
}

const getPublicSettings = async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.tenantSlug, is_active: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Store not found.' });
  const taxRate = await getActiveSalesTaxRate(tenant._id);
  res.json({
    success: true,
    data: {
      ...pickSettings(tenant),
      tax_rate: taxRate?.rate || 0,
      tax_name: taxRate?.name || '',
    },
  });
};

/**
 * The shop's logo travels with these settings, but is not one of them.
 *
 * It lives on the tenant rather than in storefront_settings because five other
 * surfaces read it from there — the marketplace card, the services page, order
 * tracking, the storefront's link preview and the payment certificate — and a
 * logo that appeared in the shop but not on a customer's receipt would be a
 * bug nobody would think to look for.
 *
 * It is carried on this endpoint anyway because this screen is where a shop
 * owner edits how their business looks in public, and until now nothing let
 * them set it at all: the field has been on the tenant since the beginning and
 * only a platform administrator could ever write to it.
 */
const getMerchantSettings = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });
  res.json({ success: true, data: { ...pickSettings(tenant), logo: tenant.logo || '' } });
};

const updateMerchantSettings = async (req, res) => {
  const tenant = await Tenant.findById(req.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found.' });

  const current = pickSettings(tenant);
  const {
    delivery_fee,
    free_delivery_threshold,
    store_enabled,
    announcement,
    min_order_amount,
    custom_domain,
    brand_color,
    banner_image,
    tagline,
    hero_headline,
    logo,
  } = req.body;

  // Not part of storefront_settings — see getMerchantSettings for why it is
  // on the tenant, and why it is nonetheless edited from here.
  if (logo !== undefined) tenant.logo = safeImageUrl(logo);

  tenant.storefront_settings = {
    delivery_fee: delivery_fee !== undefined ? Number(delivery_fee) : current.delivery_fee,
    free_delivery_threshold: free_delivery_threshold !== undefined ? Number(free_delivery_threshold) : current.free_delivery_threshold,
    store_enabled: store_enabled !== undefined ? Boolean(store_enabled) : current.store_enabled,
    announcement: announcement !== undefined ? String(announcement) : current.announcement,
    min_order_amount: min_order_amount !== undefined ? Number(min_order_amount) : current.min_order_amount,
    custom_domain: custom_domain !== undefined ? String(custom_domain).toLowerCase().trim() : current.custom_domain,
    brand_color: brand_color !== undefined ? safeHex(brand_color) : current.brand_color,
    banner_image: banner_image !== undefined ? safeImageUrl(banner_image) : current.banner_image,
    tagline: tagline !== undefined ? String(tagline).trim().slice(0, TAGLINE_MAX) : current.tagline,
    hero_headline: hero_headline !== undefined
      ? String(hero_headline).trim().slice(0, HEADLINE_MAX)
      : current.hero_headline,
  };
  tenant.markModified('storefront_settings');
  await tenant.save();
  res.json({ success: true, data: { ...pickSettings(tenant), logo: tenant.logo || '' } });
};

const trackOrder = async (req, res) => {
  const tenant = await Tenant.findOne({ slug: req.params.tenantSlug, is_active: true });
  if (!tenant) return res.status(404).json({ success: false, message: 'Store not found.' });

  const ref = decodeURIComponent(req.params.reference || '').trim();
  if (!ref) return res.status(400).json({ success: false, message: 'Order reference required.' });

  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const query = {
    tenant_id: tenant._id,
    source: 'storefront',
    $or: [{ order_number: new RegExp(`^${escaped}$`, 'i') }],
  };
  if (mongoose.isValidObjectId(ref)) query.$or.push({ _id: ref });

  const order = await Order.findOne(query).select(
    'order_number status payment_status customer_name delivery_address items subtotal total createdAt updatedAt',
  );
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  res.json({ success: true, data: formatOrderForTrack(order) });
};

/** Legacy global track by order number (no tenant slug). */
const trackOrderLegacy = async (req, res) => {
  const ref = decodeURIComponent(req.params.orderNumber || '').trim();
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const order = await Order.findOne({
    source: 'storefront',
    order_number: new RegExp(`^${escaped}$`, 'i'),
  }).select(
    'order_number status payment_status customer_name delivery_address items total createdAt branch_id',
  );
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  res.json({ success: true, data: formatOrderForTrack(order) });
};

/** Resolve a custom domain (e.g. shop.example.com) to tenant slug — public */
const resolveDomain = async (req, res) => {
  const host = String(req.query.host || '').toLowerCase().split(':')[0].trim();
  if (!host) return res.status(400).json({ success: false, message: 'host query param required.' });

  const tenants = await Tenant.find({ is_active: true, 'storefront_settings.custom_domain': { $ne: '' } });
  const match = tenants.find((t) => {
    const domain = pickSettings(t).custom_domain;
    return domain && (domain === host || host.endsWith(`.${domain}`));
  });

  if (!match) return res.status(404).json({ success: false, message: 'No store found for this domain.' });

  res.json({
    success: true,
    data: {
      slug: match.slug,
      business_name: match.business_name,
      store_url: `/store/${match.slug}`,
    },
  });
};

module.exports = {
  pickSettings,
  calcDeliveryFee,
  getPublicSettings,
  getMerchantSettings,
  updateMerchantSettings,
  trackOrder,
  trackOrderLegacy,
  resolveDomain,
};
