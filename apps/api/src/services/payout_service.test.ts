/**
 * Payout service tests.
 *
 *  - priorWeek(): pure date math, always runs.
 *  - computeCommissionPaise(): policy invariants — SKIPPED until the TODO(human)
 *    body lands. Un-skip the describe block once it's implemented.
 *  - executePayout / listPayouts: integration (needs RUN_INTEGRATION + a DB).
 */
import { describe, expect, it } from 'vitest';
import { computeCommissionPaise, priorWeek } from './payout_service.js';

describe('priorWeek', () => {
  it('returns the previous Mon→Mon window for a mid-week date', () => {
    // 2026-05-29 is a Friday. This week's Monday is 05-25; prior week 05-18.
    const { start, end } = priorWeek(new Date('2026-05-29T09:30:00Z'));
    expect(start.toISOString()).toBe('2026-05-18T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-25T00:00:00.000Z');
  });

  it('on a Monday, settles the week that just ended', () => {
    const { start, end } = priorWeek(new Date('2026-05-25T03:00:00Z'));
    expect(start.toISOString()).toBe('2026-05-18T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-25T00:00:00.000Z');
  });

  it('produces a 7-day window', () => {
    const { start, end } = priorWeek(new Date('2026-01-01T12:00:00Z'));
    expect((end.getTime() - start.getTime()) / 86_400_000).toBe(7);
  });
});

// Un-skip after implementing computeCommissionPaise (TODO(human)). These
// assertions are policy-agnostic — they hold for commission-on-gross or
// commission-on-net, and for floor/round/ceil rounding.
describe.skip('computeCommissionPaise — invariants', () => {
  it('is zero when the rate is zero', () => {
    expect(computeCommissionPaise(100_000, 0, 0)).toBe(0);
  });

  it('returns a non-negative integer', () => {
    const c = computeCommissionPaise(123_457, 1_111, 750);
    expect(Number.isInteger(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(0);
  });

  it('never exceeds the gross', () => {
    expect(computeCommissionPaise(100_000, 0, 10_000)).toBeLessThanOrEqual(100_000);
  });

  it('charges more as the rate rises', () => {
    const lo = computeCommissionPaise(100_000, 0, 200);
    const hi = computeCommissionPaise(100_000, 0, 800);
    expect(hi).toBeGreaterThan(lo);
  });

  it('takes a real cut on a non-zero rate', () => {
    expect(computeCommissionPaise(100_000, 0, 500)).toBeGreaterThan(0);
  });
});
