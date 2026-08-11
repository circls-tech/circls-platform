import { describe, expect, it } from 'vitest';
import { computeCheckout } from './checkout_pricing.js';
import {
  type ResolvedBillingConfig,
  buildBillingMetadata,
  computeChargeSnapshots,
} from './billing_config.js';

const cfg = (over: Partial<ResolvedBillingConfig>): ResolvedBillingConfig => ({
  partnerCommissionBps: 0,
  consumerCommissionBps: 0,
  customerShareBps: 10_000,
  orgShareBps: 0,
  advancePayoutBps: 0,
  ...over,
});

describe('computeChargeSnapshots', () => {
  it('defaults reproduce the legacy settle base with zero snapshots', () => {
    const billing = cfg({});
    const b = computeCheckout(50000, null, 'razorpay', billing);
    const s = computeChargeSnapshots(50000, b, billing);
    expect(s).toEqual({
      settleBasePaise: 50000,
      partnerCommissionPaise: 0,
      consumerCommissionPaise: 0,
      advancePaise: 0,
    });
  });

  it('deducts the org fee share from the settle base', () => {
    const billing = cfg({ orgShareBps: 3_000 });
    const b = computeCheckout(50000, null, 'razorpay', billing);
    // F̂ = 1209, org share = floor(1209 × 0.3) = 362.
    const s = computeChargeSnapshots(50000, b, billing);
    expect(s.settleBasePaise).toBe(50000 - 362);
  });

  it('takes partner commission on the PRE-fee base, independent of the fee split', () => {
    const withSplit = cfg({ partnerCommissionBps: 500, orgShareBps: 3_000 });
    const noSplit = cfg({ partnerCommissionBps: 500 });
    const sSplit = computeChargeSnapshots(
      50000,
      computeCheckout(50000, null, 'razorpay', withSplit),
      withSplit,
    );
    const sPlain = computeChargeSnapshots(
      50000,
      computeCheckout(50000, null, 'razorpay', noSplit),
      noSplit,
    );
    expect(sSplit.partnerCommissionPaise).toBe(2_500);
    expect(sPlain.partnerCommissionPaise).toBe(2_500);
  });

  it('advance is a floored slice of net (settle base − partner commission)', () => {
    const billing = cfg({ partnerCommissionBps: 500, advancePayoutBps: 3_000 });
    const b = computeCheckout(50000, null, 'razorpay', billing);
    const s = computeChargeSnapshots(50000, b, billing);
    // settleBase 50000, commission 2500 → net 47500, advance = floor(47500 × 0.3) = 14250.
    expect(s.advancePaise).toBe(14_250);
    expect(s.advancePaise).toBeLessThanOrEqual(s.settleBasePaise - s.partnerCommissionPaise);
  });

  it('clamps the tiny-base + Stripe + full-org-share corner at zero, commission co-clamped', () => {
    const billing = cfg({ partnerCommissionBps: 10_000, orgShareBps: 10_000, customerShareBps: 0 });
    const b = computeCheckout(10, null, 'stripe', billing);
    // F̂ (≈31) exceeds the 10-minor-unit base — settle base clamps to 0.
    const s = computeChargeSnapshots(10, b, billing);
    expect(s.settleBasePaise).toBe(0);
    expect(s.partnerCommissionPaise).toBe(0);
    expect(s.advancePaise).toBe(0);
  });

  it('platform-funded coupons keep the full base as the commission base', () => {
    const billing = cfg({ partnerCommissionBps: 1_000 });
    const b = computeCheckout(
      50000,
      { discountType: 'percent', discountValue: 1000, maxDiscountPaise: null },
      'razorpay',
      billing,
    );
    // Caller passes the full base for platform-funded sales (existing rule).
    const s = computeChargeSnapshots(50000, b, billing);
    expect(s.settleBasePaise).toBe(50000);
    expect(s.partnerCommissionPaise).toBe(5_000);
  });
});

describe('buildBillingMetadata', () => {
  it('captures every rate and the fee amounts for forensics', () => {
    const billing = cfg({
      partnerCommissionBps: 500,
      consumerCommissionBps: 200,
      customerShareBps: 5_000,
      orgShareBps: 2_000,
      advancePayoutBps: 3_000,
    });
    expect(
      buildBillingMetadata(billing, { orgFeeSharePaise: 241, gatewayFeeEstimatePaise: 1207 }),
    ).toEqual({
      partnerCommissionBps: 500,
      consumerCommissionBps: 200,
      customerShareBps: 5_000,
      orgShareBps: 2_000,
      advancePayoutBps: 3_000,
      orgFeeSharePaise: 241,
      gatewayFeeEstimatePaise: 1207,
    });
  });
});
