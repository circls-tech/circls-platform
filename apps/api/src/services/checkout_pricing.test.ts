import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BILLING,
  RAZORPAY_FEE_RATE,
  STRIPE_FEE_FIXED_MINOR,
  STRIPE_FEE_RATE,
  type BillingKnobs,
  computeCheckout,
  computeDiscountPaise,
  estimateGatewayFeePaise,
  grossUp,
  grossUpShared,
} from './checkout_pricing.js';

const billing = (over: Partial<BillingKnobs>): BillingKnobs => ({ ...DEFAULT_BILLING, ...over });

describe('grossUp', () => {
  it('grosses up to recover the Razorpay fee, rounding up', () => {
    // 50000 / (1 - 0.0236) = 51208.52… → ceil 51209
    expect(grossUp(50000)).toBe(51209);
  });
  it('defaults to the razorpay fee model', () => {
    expect(grossUp(50000)).toBe(grossUp(50000, 'razorpay'));
  });
  it('grosses up Stripe with the fixed 30¢ component included', () => {
    // (50000 + 30) / (1 - 0.029) = 51524.20… → ceil 51525
    expect(grossUp(50000, 'stripe')).toBe(51525);
    // Net check: total − (rate·total + fixed) must cover the base.
    const total = grossUp(1299, 'stripe');
    expect(total - (STRIPE_FEE_RATE * total + STRIPE_FEE_FIXED_MINOR)).toBeGreaterThanOrEqual(1299);
  });
  it('returns 0 for a zero or negative base on either gateway', () => {
    expect(grossUp(0)).toBe(0);
    expect(grossUp(-10)).toBe(0);
    expect(grossUp(0, 'stripe')).toBe(0);
  });
  it('uses the published rate constants', () => {
    expect(RAZORPAY_FEE_RATE).toBe(0.0236);
    expect(STRIPE_FEE_RATE).toBe(0.029);
    expect(STRIPE_FEE_FIXED_MINOR).toBe(30);
  });
});

describe('computeDiscountPaise', () => {
  it('computes a percentage discount in basis points, floored to whole paise', () => {
    expect(computeDiscountPaise(50000, { discountType: 'percent', discountValue: 1000, maxDiscountPaise: null })).toBe(5000);
  });
  it('caps a percentage discount at maxDiscountPaise', () => {
    expect(computeDiscountPaise(50000, { discountType: 'percent', discountValue: 1000, maxDiscountPaise: 3000 })).toBe(3000);
  });
  it('floors a fractional percentage discount to whole paise', () => {
    // 10001 * 1000 / 10000 = 1000.1 → floor 1000
    expect(computeDiscountPaise(10001, { discountType: 'percent', discountValue: 1000, maxDiscountPaise: null })).toBe(1000);
  });
  it('applies a fixed discount in paise', () => {
    expect(computeDiscountPaise(50000, { discountType: 'fixed', discountValue: 5000, maxDiscountPaise: null })).toBe(5000);
  });
  it('never discounts more than the base', () => {
    expect(computeDiscountPaise(50000, { discountType: 'fixed', discountValue: 60000, maxDiscountPaise: null })).toBe(50000);
  });
});

describe('computeCheckout', () => {
  it('grosses up the base when there is no coupon', () => {
    expect(computeCheckout(50000, null)).toEqual({
      basePaise: 50000,
      discountPaise: 0,
      discountedBasePaise: 50000,
      consumerCommissionPaise: 0,
      gatewayFeeCustomerPaise: 1209,
      otherChargesPaise: 1209,
      totalPaise: 51209,
      gatewayFeeEstimatePaise: 1209,
      orgFeeSharePaise: 0,
    });
  });
  it('applies the discount to the base, then grosses up the reduced base', () => {
    expect(computeCheckout(50000, { discountType: 'percent', discountValue: 1000, maxDiscountPaise: null })).toEqual({
      basePaise: 50000,
      discountPaise: 5000,
      discountedBasePaise: 45000,
      consumerCommissionPaise: 0,
      gatewayFeeCustomerPaise: 1088,
      otherChargesPaise: 1088,
      totalPaise: 46088,
      gatewayFeeEstimatePaise: 1088,
      orgFeeSharePaise: 0,
    });
  });
  it('yields a free total when the discount covers the whole base', () => {
    expect(computeCheckout(50000, { discountType: 'fixed', discountValue: 60000, maxDiscountPaise: null })).toEqual({
      basePaise: 50000,
      discountPaise: 50000,
      discountedBasePaise: 0,
      consumerCommissionPaise: 0,
      gatewayFeeCustomerPaise: 0,
      otherChargesPaise: 0,
      totalPaise: 0,
      gatewayFeeEstimatePaise: 0,
      orgFeeSharePaise: 0,
    });
  });
  it('uses the Stripe fee model when quoted for a stripe gateway', () => {
    expect(computeCheckout(50000, null, 'stripe')).toEqual({
      basePaise: 50000,
      discountPaise: 0,
      discountedBasePaise: 50000,
      consumerCommissionPaise: 0,
      gatewayFeeCustomerPaise: 1525,
      otherChargesPaise: 1525,
      totalPaise: 51525,
      gatewayFeeEstimatePaise: 1525,
      orgFeeSharePaise: 0,
    });
  });
  it('a fully-discounted Stripe checkout is free (no stranded fixed fee)', () => {
    expect(computeCheckout(50000, { discountType: 'fixed', discountValue: 60000, maxDiscountPaise: null }, 'stripe').totalPaise).toBe(0);
  });
});

describe('billing knobs', () => {
  it('DEFAULT_BILLING reproduces the legacy grossUp totals exactly', () => {
    for (const base of [1, 7, 999, 1299, 45000, 50000, 123457]) {
      for (const provider of ['razorpay', 'stripe'] as const) {
        expect(computeCheckout(base, null, provider, DEFAULT_BILLING).totalPaise).toBe(
          grossUp(base, provider),
        );
      }
    }
  });

  it('grossUpShared at 10000 bps equals grossUp; at 0 bps the total is the bare amount', () => {
    expect(grossUpShared(50000, 'razorpay', 10_000)).toBe(grossUp(50000));
    expect(grossUpShared(50000, 'stripe', 10_000)).toBe(grossUp(50000, 'stripe'));
    expect(grossUpShared(50000, 'razorpay', 0)).toBe(50000);
    expect(grossUpShared(50000, 'stripe', 0)).toBe(50000);
  });

  it('a 50% customer share halves the fee burden (up to rounding)', () => {
    // T = ceil(50000 / (1 − 0.5·0.0236)) = ceil(50597.06…) = 50598
    const b = computeCheckout(50000, null, 'razorpay', billing({ customerShareBps: 5_000 }));
    expect(b.totalPaise).toBe(50598);
    expect(b.gatewayFeeCustomerPaise).toBe(598);
    expect(b.otherChargesPaise).toBe(598);
  });

  it('consumer commission is floored on the discounted base and grossed up with it', () => {
    // K = floor(45000 × 200 / 10000) = 900; T = grossUp(45900) = ceil(47009.42…) = 47010
    const b = computeCheckout(
      50000,
      { discountType: 'percent', discountValue: 1000, maxDiscountPaise: null },
      'razorpay',
      billing({ consumerCommissionBps: 200 }),
    );
    expect(b.consumerCommissionPaise).toBe(900);
    expect(b.totalPaise).toBe(47010);
    expect(b.otherChargesPaise).toBe(b.consumerCommissionPaise + b.gatewayFeeCustomerPaise);
  });

  it('free stays free with commission and fee shares on either gateway', () => {
    const knobs = billing({ consumerCommissionBps: 500, customerShareBps: 5_000, orgShareBps: 2_000 });
    for (const provider of ['razorpay', 'stripe'] as const) {
      const b = computeCheckout(
        50000,
        { discountType: 'fixed', discountValue: 60000, maxDiscountPaise: null },
        provider,
        knobs,
      );
      expect(b.totalPaise).toBe(0);
      expect(b.consumerCommissionPaise).toBe(0);
      expect(b.orgFeeSharePaise).toBe(0);
    }
  });

  it('org fee share is a floored slice of the fee estimate', () => {
    // Defaults: T = 51209, F̂ = ceil(0.0236 × 51209) = 1209; org 30% → floor(362.7) = 362
    const b = computeCheckout(50000, null, 'razorpay', billing({ orgShareBps: 3_000 }));
    expect(b.gatewayFeeEstimatePaise).toBe(1209);
    expect(b.orgFeeSharePaise).toBe(362);
  });

  it('estimateGatewayFeePaise covers the real fee (never under-collects)', () => {
    for (const total of [1, 999, 46088, 51209, 51525]) {
      expect(estimateGatewayFeePaise(total, 'razorpay')).toBeGreaterThanOrEqual(
        RAZORPAY_FEE_RATE * total,
      );
      expect(estimateGatewayFeePaise(total, 'stripe')).toBeGreaterThanOrEqual(
        STRIPE_FEE_RATE * total + STRIPE_FEE_FIXED_MINOR,
      );
    }
    expect(estimateGatewayFeePaise(0, 'stripe')).toBe(0);
  });

  it('property: totals cover the chargeable amount and knobs are monotone', () => {
    for (const base of [7, 999, 45000, 50000]) {
      for (const provider of ['razorpay', 'stripe'] as const) {
        let prevTotal = -1;
        for (const share of [0, 2_500, 5_000, 7_500, 10_000]) {
          const b = computeCheckout(base, null, provider, billing({ customerShareBps: share }));
          // Customer never pays less than base + K, and fee share ≥ 0.
          expect(b.totalPaise).toBeGreaterThanOrEqual(b.discountedBasePaise + b.consumerCommissionPaise);
          expect(b.gatewayFeeCustomerPaise).toBeGreaterThanOrEqual(0);
          // Raising the customer share never lowers the total.
          expect(b.totalPaise).toBeGreaterThanOrEqual(prevTotal);
          prevTotal = b.totalPaise;
        }
        let prevK = -1;
        for (const bps of [0, 100, 250, 500, 1_000]) {
          const b = computeCheckout(base, null, provider, billing({ consumerCommissionBps: bps }));
          expect(b.consumerCommissionPaise).toBeGreaterThanOrEqual(prevK);
          expect(b.otherChargesPaise).toBe(b.consumerCommissionPaise + b.gatewayFeeCustomerPaise);
          prevK = b.consumerCommissionPaise;
        }
      }
    }
  });
});
