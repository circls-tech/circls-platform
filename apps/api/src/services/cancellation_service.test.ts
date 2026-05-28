/**
 * Cancellation policy — pure unit tests for the refund-tier function.
 * No DB, no integration env required.
 */
import { describe, expect, it } from 'vitest';
import { computeRefundPolicy } from './cancellation_policy.js';

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
