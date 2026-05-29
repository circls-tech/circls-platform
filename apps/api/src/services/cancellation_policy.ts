/**
 * Refund policy — pure function (no DB, no I/O). Phase 14.
 *
 * Tiers based on how long until the booking starts:
 *   - more than 24 h     → full refund
 *   - 2 h to 24 h        → 50% refund
 *   - less than 2 h      → no refund
 *
 * Special cases:
 *   - Free booking (no amount paid)                  → no refund, just cancel.
 *   - Walk-in / external payment (cash at venue)      → no refund logic; cash
 *     refunds are handled offline.
 *   - Staff/admin override (`bySelf=false`)           → out-of-policy full
 *     refund. The audit log flags this as discretionary.
 */
export type BookingPaymentMethod = 'razorpay_route' | 'external' | 'free';

export interface RefundPolicy {
  /** Refund amount in paise; positive integer. */
  refundPaise: number;
  /** Which tier the policy hit. Useful for audit + admin UI. */
  tier: 'full' | 'partial' | 'none' | 'override' | 'free' | 'external';
}

export function computeRefundPolicy(
  bookingSlotStart: Date,
  paymentMethod: BookingPaymentMethod,
  amountPaise: number,
  bySelf: boolean,
  now: Date = new Date(),
): RefundPolicy {
  // Cash-paid walk-ins: never auto-refund through this engine. The Partner
  // can cancel; cash is settled at the counter.
  if (paymentMethod === 'external') {
    return { refundPaise: 0, tier: 'external' };
  }

  // No money moved — nothing to give back.
  if (paymentMethod === 'free' || amountPaise <= 0) {
    return { refundPaise: 0, tier: 'free' };
  }

  // Staff/admin override: ignore the timing tiers and grant a full refund.
  // The audit row records `bySelf=false` so out-of-policy refunds are visible.
  if (!bySelf) {
    return { refundPaise: amountPaise, tier: 'override' };
  }

  const msToStart = bookingSlotStart.getTime() - now.getTime();
  const hoursToStart = msToStart / (60 * 60 * 1000);

  if (hoursToStart > 24) {
    return { refundPaise: amountPaise, tier: 'full' };
  }
  if (hoursToStart >= 2) {
    // Round down to whole paise — never refund half a paisa.
    return { refundPaise: Math.floor(amountPaise / 2), tier: 'partial' };
  }
  return { refundPaise: 0, tier: 'none' };
}
