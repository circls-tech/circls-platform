import { describe, expect, it } from 'vitest';
import { REFUND_TIER_COPY, refundSentence, refundTierCopy } from './refund_copy';

const money = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

describe('refund copy', () => {
  it('words every tier', () => {
    for (const copy of Object.values(REFUND_TIER_COPY)) {
      expect(copy.label).not.toBe('');
      expect(copy.description).not.toBe('');
    }
  });

  it('says what goes back, and to whom', () => {
    expect(refundSentence({ tier: 'override', refundPaise: 46449 }, money, 'customer')).toBe(
      'Full refund (override): ₹464.49 goes back to the customer.',
    );
  });

  it('gives the reason when nothing goes back', () => {
    expect(refundSentence({ tier: 'uncaptured', refundPaise: 0 }, money, 'attendee')).toBe(
      'No refund: The payment was never completed — nothing was charged.',
    );
  });

  it('falls back for a tier this build does not know', () => {
    expect(refundTierCopy('store_credit')).toEqual({ label: 'store_credit', description: '' });
    expect(
      refundSentence({ tier: 'store_credit' as never, refundPaise: 0 }, money, 'customer'),
    ).toBe('No refund.');
  });
});
