/**
 * Client-side preview of the refund the cancellation engine WILL grant, so the
 * partner sees the number before they click. Mirrors the API's
 * `computeRefundPolicy` (apps/api/src/services/cancellation_policy.ts) plus the
 * engine's "never-captured charge refunds nothing" rule. The backend is still
 * the source of truth on POST.
 *
 * The timing tiers only apply when the booking's own customer cancels
 * (`bySelf`). A refund issued by tenant staff — the normal case in this portal
 * — is an out-of-policy FULL refund regardless of how close the slot is.
 */
export type RefundPreviewTier =
  | 'full'
  | 'partial'
  | 'none'
  | 'override'
  | 'free'
  | 'external'
  /** The charge was never captured — nothing to give back. */
  | 'uncaptured'
  /** Self-cancel of a booking with no slot (event/membership): the tier hangs
   *  on a start time this page doesn't have, so only the server can say. */
  | 'unknown';

export interface RefundPreviewInput {
  paymentMethod: string;
  /** What was charged, in paise (the charge row, else the booking total). */
  amountPaise: number;
  /** Is the viewer the booking's own customer? The API's `bySelf`. */
  bySelf: boolean;
  /** First slot's start. Absent for event and membership bookings. */
  slotStartIso?: string | undefined;
  /** Status of the booking's charge row, when there is one. */
  chargeStatus?: string | undefined;
  now?: Date;
}

export interface RefundPreview {
  /** Refund in paise, or null when it can't be known client-side. */
  paise: number | null;
  tier: RefundPreviewTier;
}

export function previewRefund(input: RefundPreviewInput): RefundPreview {
  const { paymentMethod, amountPaise, bySelf, slotStartIso, chargeStatus } = input;
  if (paymentMethod === 'external') return { paise: 0, tier: 'external' };
  if (paymentMethod === 'free' || amountPaise <= 0) return { paise: 0, tier: 'free' };
  if (chargeStatus === 'pending') return { paise: 0, tier: 'uncaptured' };
  if (!bySelf) return { paise: amountPaise, tier: 'override' };

  if (!slotStartIso) return { paise: null, tier: 'unknown' };
  const now = input.now ?? new Date();
  const hours = (new Date(slotStartIso).getTime() - now.getTime()) / (60 * 60 * 1000);
  if (hours > 24) return { paise: amountPaise, tier: 'full' };
  if (hours >= 2) return { paise: Math.floor(amountPaise / 2), tier: 'partial' };
  return { paise: 0, tier: 'none' };
}
