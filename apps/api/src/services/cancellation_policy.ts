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
 *
 * `decideRefund()` applies this policy to the money actually held (captured?
 * already partly refunded?) — that is what the cancel engine and its preview use.
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

/**
 * Every tier a cancellation reports: the policy tiers above, plus the two
 * cases where the money itself decides — nothing was ever captured, or all of
 * it has been refunded already.
 */
export type RefundTier = RefundPolicy['tier'] | 'uncaptured' | 'already_refunded';

/** Charge statuses under which the customer's money actually reached us. */
const CAPTURED_STATUSES: ReadonlySet<string> = new Set([
  'captured',
  'partially_refunded',
  'refunded',
]);

export interface RefundDecisionInput {
  bookingSlotStart: Date;
  paymentMethod: BookingPaymentMethod;
  /** The booking's most recent charge row; null when it has none. */
  charge: { amountPaise: number; status: string } | null;
  /** The amount the policy applies to when there is no charge row. */
  bookingTotalPaise: number;
  /** Cash already refunded against the charge (every refund row not 'failed'). */
  alreadyRefundedPaise: number;
  bySelf: boolean;
  now?: Date;
}

export interface RefundDecision {
  tier: RefundTier;
  /** What cancelling now refunds, in paise. */
  refundPaise: number;
  /** What the policy was applied to: the charge, else the booking total. */
  amountPaise: number;
}

/**
 * The refund a cancellation grants: {@link computeRefundPolicy}, bounded by the
 * money actually held. The cancel engine and its preview both decide through
 * here, so the preview can't promise what the cancel won't do.
 *
 *   - Nothing captured (no charge row, or a charge that never completed)
 *     → nothing to refund, whatever the tier would have paid.
 *   - Part of the charge already refunded (e.g. a goodwill refund) → the tier's
 *     amount, capped at what is left; all of it refunded → nothing more.
 */
export function decideRefund(input: RefundDecisionInput): RefundDecision {
  const amountPaise = input.charge ? input.charge.amountPaise : input.bookingTotalPaise;
  const policy = computeRefundPolicy(
    input.bookingSlotStart,
    input.paymentMethod,
    amountPaise,
    input.bySelf,
    input.now,
  );
  if (policy.tier === 'external' || policy.tier === 'free') {
    return { tier: policy.tier, refundPaise: 0, amountPaise };
  }
  if (!input.charge || !CAPTURED_STATUSES.has(input.charge.status)) {
    return { tier: 'uncaptured', refundPaise: 0, amountPaise };
  }
  if (policy.refundPaise === 0) return { tier: policy.tier, refundPaise: 0, amountPaise };

  const remaining = amountPaise - input.alreadyRefundedPaise;
  if (remaining <= 0) return { tier: 'already_refunded', refundPaise: 0, amountPaise };
  return { tier: policy.tier, refundPaise: Math.min(policy.refundPaise, remaining), amountPaise };
}
