import { describe, expect, it } from 'vitest';
import { validateCoupon, type CouponValidationContext } from './coupon_service.js';
import type { Coupon } from '../db/schema/coupons.js';

const NOW = new Date('2026-06-08T12:00:00.000Z');

function coupon(overrides: Partial<Coupon> = {}): Coupon {
  return {
    id: 'c1',
    ownerType: 'tenant',
    tenantId: 't1',
    code: 'SUMMER10',
    description: null,
    scopeType: 'org',
    scopeId: null,
    discountType: 'percent',
    discountValue: 1000,
    maxDiscountPaise: null,
    minOrderPaise: null,
    visibility: 'public',
    validFrom: null,
    validUntil: null,
    maxRedemptions: null,
    perUserLimit: null,
    redeemedCount: 0,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Coupon;
}

const ctx = (over: Partial<CouponValidationContext> = {}): CouponValidationContext => ({
  basePaise: 50000,
  now: NOW,
  item: { type: 'event', id: 'e1', venueId: 'v1' },
  ...over,
});

describe('validateCoupon (pure)', () => {
  it('accepts an active, in-window, org-scoped coupon', () => {
    expect(validateCoupon(coupon(), ctx())).toEqual({ ok: true });
  });
  it('rejects a paused coupon', () => {
    expect(validateCoupon(coupon({ status: 'paused' }), ctx())).toEqual({ ok: false, code: 'coupon_inactive' });
  });
  it('rejects before valid_from', () => {
    expect(validateCoupon(coupon({ validFrom: new Date('2026-07-01T00:00:00Z') }), ctx())).toEqual({ ok: false, code: 'coupon_not_started' });
  });
  it('rejects after valid_until', () => {
    expect(validateCoupon(coupon({ validUntil: new Date('2026-06-01T00:00:00Z') }), ctx())).toEqual({ ok: false, code: 'coupon_expired' });
  });
  it('rejects when base is below min_order_paise', () => {
    expect(validateCoupon(coupon({ minOrderPaise: 60000 }), ctx())).toEqual({ ok: false, code: 'coupon_min_order' });
  });
  it('rejects when total redemptions are exhausted', () => {
    expect(validateCoupon(coupon({ maxRedemptions: 5, redeemedCount: 5 }), ctx())).toEqual({ ok: false, code: 'coupon_max_redeemed' });
  });
  it('rejects a venue-scoped coupon when the item is at a different venue', () => {
    expect(validateCoupon(coupon({ scopeType: 'venue', scopeId: 'v2' }), ctx())).toEqual({ ok: false, code: 'coupon_scope_mismatch' });
  });
  it('accepts a venue-scoped coupon when the item is at that venue', () => {
    expect(validateCoupon(coupon({ scopeType: 'venue', scopeId: 'v1' }), ctx())).toEqual({ ok: true });
  });
  it('rejects an event-scoped coupon when the item id differs', () => {
    expect(validateCoupon(coupon({ scopeType: 'event', scopeId: 'e2' }), ctx())).toEqual({ ok: false, code: 'coupon_scope_mismatch' });
  });
  it('accepts an event-scoped coupon for the matching event', () => {
    expect(validateCoupon(coupon({ scopeType: 'event', scopeId: 'e1' }), ctx())).toEqual({ ok: true });
  });
});
