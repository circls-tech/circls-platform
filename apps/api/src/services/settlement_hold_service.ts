/**
 * Settlement-hold service — Phase 12 owner fills these in.
 *
 * Settlement-hold = the window between payment capture and when the funds are
 * eligible to settle to the venue (so we can refund without clawback). Default
 * buffer is `cancellation_window + SETTLEMENT_HOLD_BUFFER_MIN`; for walk-in /
 * paid-at-venue bookings the hold is N/A (we never received money).
 *
 * Contract surfaces:
 *   - holdForBooking(): called from booking confirmation flow to set
 *     `payments.settlement_hold_until` based on the booking's slot end.
 *   - releaseDueSettlements(): worker handler — marks payments whose hold has
 *     passed as `settlement_released_at`. The actual fund movement is Razorpay's
 *     job; we just track release-eligibility for our reconciliation.
 */
import { logger } from '../lib/logger.js';

export async function holdForBooking(_bookingId: string): Promise<void> {
  throw new Error('settlement_hold_service.holdForBooking not implemented — phase 12');
}

/** Worker handler — runs every 5 minutes. Returns count of released payments. */
export async function releaseDueSettlements(): Promise<number> {
  // TODO(phase-12): UPDATE payments
  //   SET settlement_released_at = now()
  //   WHERE kind='charge'
  //     AND status='captured'
  //     AND settlement_released_at IS NULL
  //     AND settlement_hold_until <= now()
  //   RETURNING id;
  logger.debug('settlement_release_ticker_stub');
  return 0;
}
