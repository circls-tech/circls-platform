import { describe, expect, it } from 'vitest';
import {
  RAZORPAY_FEE_RATE,
  STRIPE_FEE_FIXED_MINOR,
  STRIPE_FEE_RATE,
  computeCheckout,
  computeDiscountPaise,
  grossUp,
} from './checkout_pricing.js';

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
      otherChargesPaise: 1209,
      totalPaise: 51209,
    });
  });
  it('applies the discount to the base, then grosses up the reduced base', () => {
    expect(computeCheckout(50000, { discountType: 'percent', discountValue: 1000, maxDiscountPaise: null })).toEqual({
      basePaise: 50000,
      discountPaise: 5000,
      discountedBasePaise: 45000,
      otherChargesPaise: 1088,
      totalPaise: 46088,
    });
  });
  it('yields a free total when the discount covers the whole base', () => {
    expect(computeCheckout(50000, { discountType: 'fixed', discountValue: 60000, maxDiscountPaise: null })).toEqual({
      basePaise: 50000,
      discountPaise: 50000,
      discountedBasePaise: 0,
      otherChargesPaise: 0,
      totalPaise: 0,
    });
  });
  it('uses the Stripe fee model when quoted for a stripe gateway', () => {
    expect(computeCheckout(50000, null, 'stripe')).toEqual({
      basePaise: 50000,
      discountPaise: 0,
      discountedBasePaise: 50000,
      otherChargesPaise: 1525,
      totalPaise: 51525,
    });
  });
  it('a fully-discounted Stripe checkout is free (no stranded fixed fee)', () => {
    expect(computeCheckout(50000, { discountType: 'fixed', discountValue: 60000, maxDiscountPaise: null }, 'stripe').totalPaise).toBe(0);
  });
});
