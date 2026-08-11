/**
 * Checkout pricing — the single source of truth for the money model.
 *
 * Customers pay a base price grossed up to recover the payment gateway's fee,
 * less any coupon discount, plus any consumer-side platform commission. Used
 * by BOTH the consumer quote endpoint and the authoritative booking path so
 * the two can never diverge. See
 * docs/superpowers/specs/2026-06-08-coupons-transparent-checkout-design.md.
 *
 * Fees differ per gateway: Razorpay charges a flat rate; Stripe charges a rate
 * plus a fixed per-transaction amount (in the currency's minor unit).
 *
 * Billing knobs (per tenant, some per event) shape who bears what:
 *   - consumerCommissionBps: Circls's cut charged ON TOP of the discounted
 *     base — customer-visible only inside "Other charges".
 *   - customerShareBps: how much of the gateway fee the gross-up recovers
 *     from the customer (10000 = all of it, the legacy behaviour).
 *   - orgShareBps: how much of the gateway fee the org bears, deducted from
 *     its settle base. customer + org ≤ 10000; Circls absorbs the remainder.
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

/** The billing knobs that shape a checkout. All in basis points (0..10000). */
export interface BillingKnobs {
  consumerCommissionBps: number;
  customerShareBps: number;
  orgShareBps: number;
}

/** Legacy behaviour: customer pays the whole gateway fee, no commission. */
export const DEFAULT_BILLING: BillingKnobs = {
  consumerCommissionBps: 0,
  customerShareBps: 10_000,
  orgShareBps: 0,
};

/**
 * Gross an amount up so the customer covers `customerShareBps` of the gateway
 * fee: solves T = B + c·(rate·T + fixed) → T = ceil((B + c·fixed)/(1 − c·rate)).
 * `ceil` so we never under-net the base. Non-positive input → 0 (free) — the
 * guard matters for Stripe's fixed fee, which would otherwise turn a fully
 * discounted checkout into a ~30¢ charge.
 */
export function grossUpShared(
  amountPaise: number,
  provider: PaymentProviderId,
  customerShareBps: number,
): number {
  if (amountPaise <= 0) return 0;
  const fee = GATEWAY_FEES[provider];
  const c = customerShareBps / 10_000;
  return Math.ceil((amountPaise + c * fee.fixedMinor) / (1 - c * fee.rate));
}

/**
 * Gross an amount up so that, after the gateway deducts its fee (rate on the
 * grossed total, plus any fixed per-transaction amount), we net the input.
 * The customer-pays-everything special case of `grossUpShared`.
 */
export function grossUp(amountPaise: number, provider: PaymentProviderId = 'razorpay'): number {
  return grossUpShared(amountPaise, provider, 10_000);
}

/**
 * Integer estimate of the gateway's fee on a charged total. `ceil` on the rate
 * component (matches Razorpay's round-up-with-GST practice and never
 * under-collects the org's share); the org's slice of it is floored, so
 * sub-paise crumbs land on the platform.
 */
export function estimateGatewayFeePaise(
  totalPaise: number,
  provider: PaymentProviderId,
): number {
  if (totalPaise <= 0) return 0;
  const fee = GATEWAY_FEES[provider];
  return Math.ceil(fee.rate * totalPaise) + fee.fixedMinor;
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
  /** Consumer-side platform commission (K), floored on the discounted base. */
  consumerCommissionPaise: number;
  /** The gateway-fee share the customer pays: total − discountedBase − K. */
  gatewayFeeCustomerPaise: number;
  /** total − discountedBase: the "Other charges (incl taxes)" line
   *  (= consumerCommission + the customer's gateway-fee share). */
  otherChargesPaise: number;
  /** What the customer pays. 0 ⇒ free, skip the gateway. */
  totalPaise: number;
  /** Estimated full gateway fee on the total (org-billing data — never
   *  expose to consumers). */
  gatewayFeeEstimatePaise: number;
  /** The org's floored share of the gateway fee, to deduct from its settle
   *  base (org-billing data — never expose to consumers). */
  orgFeeSharePaise: number;
}

/** Full breakdown for a base price, an optional coupon, and billing knobs. */
export function computeCheckout(
  basePaise: number,
  coupon: CouponForPricing | null,
  provider: PaymentProviderId = 'razorpay',
  billing: BillingKnobs = DEFAULT_BILLING,
): CheckoutBreakdown {
  const discountPaise = coupon ? computeDiscountPaise(basePaise, coupon) : 0;
  const discountedBasePaise = Math.max(0, basePaise - discountPaise);
  const consumerCommissionPaise = Math.floor(
    (discountedBasePaise * billing.consumerCommissionBps) / 10_000,
  );
  const chargeablePaise = discountedBasePaise + consumerCommissionPaise;
  const totalPaise = grossUpShared(chargeablePaise, provider, billing.customerShareBps);
  const gatewayFeeEstimatePaise = estimateGatewayFeePaise(totalPaise, provider);
  const orgFeeSharePaise = Math.floor((gatewayFeeEstimatePaise * billing.orgShareBps) / 10_000);
  return {
    basePaise,
    discountPaise,
    discountedBasePaise,
    consumerCommissionPaise,
    gatewayFeeCustomerPaise: totalPaise - chargeablePaise,
    otherChargesPaise: totalPaise - discountedBasePaise,
    totalPaise,
    gatewayFeeEstimatePaise,
    orgFeeSharePaise,
  };
}
