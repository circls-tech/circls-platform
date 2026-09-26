import { describe, expect, it } from 'vitest';
import { previewRefund } from './refund_preview';

const NOW = new Date('2032-03-06T12:00:00.000Z');
const inHours = (h: number) => new Date(NOW.getTime() + h * 60 * 60 * 1000).toISOString();

describe('previewRefund — staff refund (bySelf=false)', () => {
  const base = { paymentMethod: 'razorpay_route', amountPaise: 46449, bySelf: false, now: NOW };

  it('is a full override refund even inside 2 hours of the slot', () => {
    expect(previewRefund({ ...base, slotStartIso: inHours(1) })).toEqual({
      paise: 46449,
      tier: 'override',
    });
  });

  it('is a full override refund for a slot that already started', () => {
    expect(previewRefund({ ...base, slotStartIso: inHours(-3) }).tier).toBe('override');
  });

  it('is a full override refund for an event/membership booking with no slot', () => {
    expect(previewRefund({ ...base, slotStartIso: undefined })).toEqual({
      paise: 46449,
      tier: 'override',
    });
  });

  it('refunds nothing for cash paid at the venue', () => {
    expect(previewRefund({ ...base, paymentMethod: 'external' })).toEqual({ paise: 0, tier: 'external' });
  });

  it('refunds nothing for a free booking or a zero amount', () => {
    expect(previewRefund({ ...base, paymentMethod: 'free' }).tier).toBe('free');
    expect(previewRefund({ ...base, amountPaise: 0 })).toEqual({ paise: 0, tier: 'free' });
  });

  it('refunds nothing when the charge was never captured', () => {
    expect(previewRefund({ ...base, chargeStatus: 'pending' })).toEqual({ paise: 0, tier: 'uncaptured' });
    expect(previewRefund({ ...base, chargeStatus: 'captured' }).tier).toBe('override');
  });
});

describe('previewRefund — customer self-cancel (bySelf=true)', () => {
  const base = { paymentMethod: 'razorpay_route', amountPaise: 10001, bySelf: true, now: NOW };

  it('applies the timing tiers', () => {
    expect(previewRefund({ ...base, slotStartIso: inHours(25) })).toEqual({ paise: 10001, tier: 'full' });
    expect(previewRefund({ ...base, slotStartIso: inHours(24) })).toEqual({ paise: 5000, tier: 'partial' });
    expect(previewRefund({ ...base, slotStartIso: inHours(2) })).toEqual({ paise: 5000, tier: 'partial' });
    expect(previewRefund({ ...base, slotStartIso: inHours(1.5) })).toEqual({ paise: 0, tier: 'none' });
  });

  it('does not claim "out of window" when there is no slot start', () => {
    expect(previewRefund({ ...base, slotStartIso: undefined })).toEqual({ paise: null, tier: 'unknown' });
  });
});
