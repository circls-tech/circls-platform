import { describe, expect, it } from 'vitest';
import {
  RAZORPAY_FEE_RATE,
  computeCheckout,
  computeDiscountPaise,
  grossUp,
} from './checkout_pricing.js';

describe('grossUp', () => {
  it('grosses up to recover the Razorpay fee, rounding up', () => {
    // 50000 / (1 - 0.0236) = 51208.52… → ceil 51209
    expect(grossUp(50000)).toBe(51209);
  });
  it('returns 0 for a zero or negative base', () => {
    expect(grossUp(0)).toBe(0);
    expect(grossUp(-10)).toBe(0);
  });
  it('uses the 2.36% rate constant', () => {
    expect(RAZORPAY_FEE_RATE).toBe(0.0236);
  });
});

describe('computeDiscountPaise', () => {
  it('computes a percentage discount in basis points, floored to whole paise', () => {
    expect(computeDiscountPaise(50000, { discountType: 'percent', discountValue: 1000, maxDiscountPaise: null })).toBe(5000);
  });
  it('caps a percentage discount at maxDiscountPaise', () => {
    expect(computeDiscountPaise(50000, { discountType: 'percent', discountValue: 1000, maxDiscountPaise: 3000 })).toBe(3000);
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
});
