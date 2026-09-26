/**
 * Cancellation policy — pure unit tests for the refund-tier and refund-decision functions.
 * No DB, no integration env required.
 */
import { describe, expect, it } from 'vitest';
import { computeRefundPolicy, decideRefund } from './cancellation_policy.js';

const NOW = new Date('2026-06-01T12:00:00Z');
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 60 * 60 * 1000);

describe('computeRefundPolicy', () => {
  describe('razorpay_route (paid online)', () => {
    it('grants a full refund > 24h out', () => {
      const p = computeRefundPolicy(hoursAhead(25), 'razorpay_route', 50000, true, NOW);
      expect(p).toEqual({ refundPaise: 50000, tier: 'full' });
    });

    it('grants a 50% refund exactly at the 24h boundary', () => {
      const p = computeRefundPolicy(hoursAhead(24), 'razorpay_route', 50000, true, NOW);
      expect(p).toEqual({ refundPaise: 25000, tier: 'partial' });
    });

    it('grants a 50% refund somewhere mid-window', () => {
      const p = computeRefundPolicy(hoursAhead(12), 'razorpay_route', 50000, true, NOW);
      expect(p.tier).toBe('partial');
      expect(p.refundPaise).toBe(25000);
    });

    it('grants a 50% refund at the 2h boundary', () => {
      const p = computeRefundPolicy(hoursAhead(2), 'razorpay_route', 50000, true, NOW);
      expect(p).toEqual({ refundPaise: 25000, tier: 'partial' });
    });

    it('rounds odd-paise halves down', () => {
      // 99 paise / 2 = 49 (not 49.5)
      const p = computeRefundPolicy(hoursAhead(12), 'razorpay_route', 99, true, NOW);
      expect(p.refundPaise).toBe(49);
    });

    it('grants no refund inside the 2h cutoff', () => {
      const p = computeRefundPolicy(hoursAhead(1.5), 'razorpay_route', 50000, true, NOW);
      expect(p).toEqual({ refundPaise: 0, tier: 'none' });
    });

    it('grants no refund when slot is in the past', () => {
      const p = computeRefundPolicy(hoursAhead(-1), 'razorpay_route', 50000, true, NOW);
      expect(p).toEqual({ refundPaise: 0, tier: 'none' });
    });
  });

  describe('staff override (bySelf=false)', () => {
    it('grants a full refund even inside the 2h cutoff', () => {
      const p = computeRefundPolicy(hoursAhead(0.5), 'razorpay_route', 50000, false, NOW);
      expect(p).toEqual({ refundPaise: 50000, tier: 'override' });
    });

    it('still grants a full refund > 24h out (same outcome, different tier)', () => {
      // The tier surfaces "this was a discretionary refund" even when the
      // amount happens to match the standard full-refund tier.
      const p = computeRefundPolicy(hoursAhead(48), 'razorpay_route', 50000, false, NOW);
      expect(p).toEqual({ refundPaise: 50000, tier: 'override' });
    });

    it('does not invent money for free bookings', () => {
      const p = computeRefundPolicy(hoursAhead(0.1), 'free', 0, false, NOW);
      expect(p).toEqual({ refundPaise: 0, tier: 'free' });
    });

    it('does not auto-refund a cash booking', () => {
      const p = computeRefundPolicy(hoursAhead(0.1), 'external', 50000, false, NOW);
      expect(p).toEqual({ refundPaise: 0, tier: 'external' });
    });
  });

  describe('special payment methods', () => {
    it('returns external tier for walk-in cash bookings', () => {
      const p = computeRefundPolicy(hoursAhead(48), 'external', 50000, true, NOW);
      expect(p).toEqual({ refundPaise: 0, tier: 'external' });
    });

    it('returns free tier for free bookings even with a stale amountPaise', () => {
      // Defence-in-depth: even if the caller passes a non-zero amount for a
      // free booking, we don't refund.
      const p = computeRefundPolicy(hoursAhead(48), 'free', 12345, true, NOW);
      expect(p).toEqual({ refundPaise: 0, tier: 'free' });
    });

    it('returns free tier when amountPaise is zero on a paid method', () => {
      // Razorpay booking that paid nothing (e.g. 100% coupon). Treat as free.
      const p = computeRefundPolicy(hoursAhead(48), 'razorpay_route', 0, true, NOW);
      expect(p).toEqual({ refundPaise: 0, tier: 'free' });
    });
  });
});

describe('decideRefund', () => {
  const captured = { amountPaise: 50000, status: 'captured' };
  const base = {
    bookingSlotStart: hoursAhead(12),
    paymentMethod: 'razorpay_route' as const,
    charge: captured,
    bookingTotalPaise: 50000,
    alreadyRefundedPaise: 0,
    bySelf: false,
    now: NOW,
  };

  it('passes the policy through for a captured, unrefunded charge', () => {
    expect(decideRefund(base)).toEqual({ tier: 'override', refundPaise: 50000, amountPaise: 50000 });
    expect(decideRefund({ ...base, bySelf: true })).toEqual({
      tier: 'partial',
      refundPaise: 25000,
      amountPaise: 50000,
    });
  });

  it('refunds nothing when the charge was never captured', () => {
    for (const status of ['pending', 'failed', 'authorized']) {
      expect(decideRefund({ ...base, charge: { amountPaise: 50000, status } })).toEqual({
        tier: 'uncaptured',
        refundPaise: 0,
        amountPaise: 50000,
      });
    }
  });

  it('refunds nothing for a paid booking with no charge row at all', () => {
    // The engine used to report the booking total as refunded here, while
    // issueRefund (which needs a charge) never ran.
    expect(decideRefund({ ...base, charge: null })).toEqual({
      tier: 'uncaptured',
      refundPaise: 0,
      amountPaise: 50000,
    });
  });

  it('caps the refund at what earlier refunds left', () => {
    expect(decideRefund({ ...base, alreadyRefundedPaise: 20000 })).toEqual({
      tier: 'override',
      refundPaise: 30000,
      amountPaise: 50000,
    });
    // The 50% tier still pays its own amount when that fits in what's left…
    expect(
      decideRefund({ ...base, bySelf: true, alreadyRefundedPaise: 20000 }).refundPaise,
    ).toBe(25000);
    // …and only what's left when it doesn't.
    expect(
      decideRefund({ ...base, bySelf: true, alreadyRefundedPaise: 40000 }).refundPaise,
    ).toBe(10000);
  });

  it('reports already_refunded once the whole charge has gone back', () => {
    expect(
      decideRefund({
        ...base,
        charge: { amountPaise: 50000, status: 'refunded' },
        alreadyRefundedPaise: 50000,
      }),
    ).toEqual({ tier: 'already_refunded', refundPaise: 0, amountPaise: 50000 });
  });

  it('keeps the policy tier when the policy itself pays nothing', () => {
    expect(decideRefund({ ...base, bySelf: true, bookingSlotStart: hoursAhead(1) })).toEqual({
      tier: 'none',
      refundPaise: 0,
      amountPaise: 50000,
    });
    expect(decideRefund({ ...base, paymentMethod: 'external', charge: null }).tier).toBe(
      'external',
    );
    expect(decideRefund({ ...base, paymentMethod: 'free', charge: null }).tier).toBe('free');
  });
});
