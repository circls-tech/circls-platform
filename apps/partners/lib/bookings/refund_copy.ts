import type { RefundPreview, RefundTier } from '@/lib/api/types';

/**
 * How each refund tier reads in the portal: the refund page's preview and
 * result, and the confirmations on the reception grid and event registrations.
 * The server decides the tier (GET /v1/bookings/:id/refund-preview and the
 * cancel itself); this only words it. Keyed by every tier, so a new one can't
 * ship without copy.
 */
export const REFUND_TIER_COPY: Record<RefundTier, { label: string; description: string }> = {
  full: { label: 'Full refund', description: 'More than 24 hours before it starts.' },
  partial: { label: '50% refund', description: '2–24 hours before it starts.' },
  none: { label: 'No refund', description: 'Less than 2 hours before it starts — out of window.' },
  override: {
    label: 'Full refund (override)',
    description: 'Refunds issued by your team are in full, whatever the timing. Logged in the audit trail.',
  },
  free: { label: 'No refund', description: 'Free booking — no money was paid.' },
  external: {
    label: 'No refund',
    description: 'Paid to you directly, not through circls — settle any refund yourself.',
  },
  uncaptured: {
    label: 'No refund',
    description: 'The payment was never completed — nothing was charged.',
  },
  already_refunded: {
    label: 'No refund',
    description: 'The payment has already been refunded in full.',
  },
};

/** Copy for a tier, tolerating one this build doesn't know yet — the API and
 *  the portal deploy separately. */
export function refundTierCopy(tier: string): { label: string; description: string } {
  return REFUND_TIER_COPY[tier as RefundTier] ?? { label: tier, description: '' };
}

/**
 * One sentence for a cancel/refund confirmation, e.g.
 * "Full refund (override): ₹464.49 goes back to the customer."
 */
export function refundSentence(
  preview: Pick<RefundPreview, 'tier' | 'refundPaise'>,
  money: (paise: number) => string,
  recipient: string,
): string {
  const copy = refundTierCopy(preview.tier);
  if (preview.refundPaise > 0) {
    return `${copy.label}: ${money(preview.refundPaise)} goes back to the ${recipient}.`;
  }
  return copy.description ? `No refund: ${copy.description}` : 'No refund.';
}
