const { Coupon } = require('../models');

async function validateCoupon({ tenantId, code, subtotal }) {
  const coupon = await Coupon.findOne({
    tenant_id: tenantId,
    code: String(code).toUpperCase().trim(),
    is_active: true,
  });
  if (!coupon) return { valid: false, message: 'Invalid coupon code.' };
  if (coupon.expires_at && coupon.expires_at < new Date()) return { valid: false, message: 'This coupon has expired.' };
  if (coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses) return { valid: false, message: 'This coupon has reached its usage limit.' };
  if (subtotal < coupon.min_order_amount) {
    return { valid: false, message: `Minimum order amount is GH₵${coupon.min_order_amount}.` };
  }

  let discount = 0;
  if (coupon.discount_type === 'percent') {
    discount = Math.round(subtotal * coupon.discount_value) / 100;
  } else {
    discount = Math.min(coupon.discount_value, subtotal);
  }

  return {
    valid: true,
    coupon,
    discount,
    code: coupon.code,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
  };
}

async function applyCouponUsage(couponId) {
  await Coupon.findByIdAndUpdate(couponId, { $inc: { used_count: 1 } });
}

module.exports = { validateCoupon, applyCouponUsage };
