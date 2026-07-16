/**
 * Checkout pricing — the single source of truth for the money model.
 *
 * Customers pay a base price grossed up to recover the payment gateway's fee,
 * less any coupon discount. Used by BOTH the consumer quote endpoint and the
 * authoritative booking path so the two can never diverge. See
 * docs/superpowers/specs/2026-06-08-coupons-transparent-checkout-design.md.
 *
 * Fees differ per gateway: Razorpay charges a flat rate; Stripe charges a rate
 * plus a fixed per-transaction amount (in the currency's minor unit).
 */
import type { PaymentProviderId } from '../lib/gateway.js';

/** Razorpay fee incl. GST on the fee. The only add-on; there is no separate ticket GST. */
export const RAZORPAY_FEE_RATE = 0.0236;

/** Stripe US card pricing: 2.9% + 30¢. */
export const STRIPE_FEE_RATE = 0.029;
export const STRIPE_FEE_FIXED_MINOR = 30;

const GATEWAY_FEES: Record<PaymentProviderId, { rate: number; fixedMinor: number }> = {
  razorpay: { rate: RAZORPAY_FEE_RATE, fixedMinor: 0 },
  stripe: { rate: STRIPE_FEE_RATE, fixedMinor: STRIPE_FEE_FIXED_MINOR },
};

/** The coupon fields needed to price a discount (a slice of the coupons row). */
export interface CouponForPricing {
  discountType: 'percent' | 'fixed';
  /** Basis points (100 = 1%) when percent; paise when fixed. */
  discountValue: number;
  /** Cap for percent coupons, in paise; null = uncapped. Ignored for fixed. */
  maxDiscountPaise: number | null;
}

/**
 * Gross an amount up so that, after the gateway deducts its fee (rate on the
 * grossed total, plus any fixed per-transaction amount), we net the input.
 * `ceil` so we never under-net the base. Non-positive input → 0 (free).
 */
export function grossUp(amountPaise: number, provider: PaymentProviderId = 'razorpay'): number {
  if (amountPaise <= 0) return 0;
  const fee = GATEWAY_FEES[provider];
  return Math.ceil((amountPaise + fee.fixedMinor) / (1 - fee.rate));
}

/** The discount in paise for `basePaise`, floored at whole paise and capped at the base. */
export function computeDiscountPaise(basePaise: number, coupon: CouponForPricing): number {
  let discount: number;
  if (coupon.discountType === 'percent') {
    discount = Math.floor((basePaise * coupon.discountValue) / 10_000);
    if (coupon.maxDiscountPaise != null) discount = Math.min(discount, coupon.maxDiscountPaise);
  } else {
    discount = Math.floor(coupon.discountValue);
  }
  return Math.max(0, Math.min(discount, basePaise));
}

export interface CheckoutBreakdown {
  basePaise: number;
  discountPaise: number;
  discountedBasePaise: number;
  /** total − discountedBase: the "Other charges (incl taxes)" line. */
  otherChargesPaise: number;
  /** What the customer pays. 0 ⇒ free, skip the gateway. */
  totalPaise: number;
}

/** Full breakdown for a base price and an optional coupon. */
export function computeCheckout(
  basePaise: number,
  coupon: CouponForPricing | null,
  provider: PaymentProviderId = 'razorpay',
): CheckoutBreakdown {
  const discountPaise = coupon ? computeDiscountPaise(basePaise, coupon) : 0;
  const discountedBasePaise = Math.max(0, basePaise - discountPaise);
  const totalPaise = grossUp(discountedBasePaise, provider);
  return {
    basePaise,
    discountPaise,
    discountedBasePaise,
    otherChargesPaise: totalPaise - discountedBasePaise,
    totalPaise,
  };
}
