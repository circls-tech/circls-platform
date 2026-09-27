import { describe, expect, it } from 'vitest';
import { fmtPrice, planSummary } from './plan_summary';
import type { Membership, MembershipTier } from './api/types';

const tier = (pricePaise: number): MembershipTier =>
  ({ id: String(pricePaise), name: 'T', pricePaise, durationDays: 30 }) as MembershipTier;

const plan = (tiers: MembershipTier[], pricePaise = 0): Membership =>
  ({ id: 'm', name: 'Plan', tiers, pricePaise }) as Membership;

describe('fmtPrice', () => {
  it('names zero rather than pricing it', () => {
    expect(fmtPrice(0, 'INR')).toBe('Free');
  });

  it('keeps the decimals, so 999.50 is not rounded to 1,000', () => {
    expect(fmtPrice(99950, 'INR')).toContain('999.50');
  });

  it('prices in the currency it is given, not a default', () => {
    expect(fmtPrice(1500, 'USD')).toContain('15.00');
    expect(fmtPrice(1500, 'USD')).not.toContain('₹');
  });
});

describe('planSummary', () => {
  it('gives the count and the range when tiers differ', () => {
    const s = planSummary(plan([tier(50000), tier(200000)]), 'INR');
    expect(s).toContain('2 tiers');
    expect(s).toContain('500.00');
    expect(s).toContain('2,000.00');
  });

  it('collapses the range when every tier costs the same', () => {
    const s = planSummary(plan([tier(50000), tier(50000)]), 'INR');
    expect(s).toBe('2 tiers · ₹500.00');
  });

  it('says tier, singular, for one', () => {
    expect(planSummary(plan([tier(50000)]), 'INR')).toContain('1 tier ·');
  });

  it('falls back to a legacy plan’s own price rather than saying "0 tiers"', () => {
    const s = planSummary(plan([], 150000), 'INR');
    expect(s).not.toContain('0 tiers');
    expect(s).toContain('1,500.00');
  });

  it('calls a free tier-less plan Free', () => {
    expect(planSummary(plan([], 0), 'INR')).toBe('Free');
  });
});
