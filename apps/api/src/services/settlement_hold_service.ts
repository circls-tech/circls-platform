/**
 * Settlement-hold service — Phase 12 (Track B).
 *
 * Settlement-hold = the window between payment capture and when the funds are
 * eligible to settle to the venue (so we can refund without clawback). Default
 * buffer is `slot end + SETTLEMENT_HOLD_BUFFER_MIN`; for walk-in / paid-at-venue
 * bookings the hold is N/A (we never received money through Route).
 *
 * Contract surfaces:
 *   - holdForBooking(): set `payments.settlement_hold_until` for the latest
 *     captured charge on a booking, based on the booking's slot end. Called
 *     from the webhook capture path. Accepts an optional executor so callers
 *     inside a transaction don't open a nested one.
 *   - releaseDueSettlements(): worker handler — marks payments whose hold has
 *     passed as `settlement_released_at`. The actual fund movement is Razorpay's
 *     job; we just track release-eligibility for our reconciliation.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bookings, payments } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/** Anything that can run a drizzle UPDATE/SELECT — both `db` and a `tx` satisfy this. */
type Executor = Pick<typeof db, 'select' | 'update'>;

/**
 * Set the settlement hold on the (single, latest) captured charge for this
 * booking. We pull the booking's `time_range` upper bound and add the buffer.
 * If the booking has no time_range (e.g. memberships, Phase 15) the hold stays
 * null and the row will simply never be picked up by releaseDueSettlements —
 * which is the correct semantics (no slot end ⇒ no settlement deadline).
 */
export async function holdForBooking(bookingId: string, exec: Executor = db): Promise<void> {
  const updated = await exec
    .update(payments)
    .set({
      settlementHoldUntil: sql`(
        select upper(time_range) + (${env.SETTLEMENT_HOLD_BUFFER_MIN}::int * interval '1 minute')
        from ${bookings} where ${bookings.id} = ${bookingId}
      )`,
    })
    .where(
      and(
        eq(payments.bookingId, bookingId),
        eq(payments.kind, 'charge'),
        eq(payments.status, 'captured'),
      ),
    )
    .returning({ id: payments.id });

  if (updated.length === 0) {
    logger.debug({ bookingId }, 'settlement_hold_no_captured_charge');
  }
}

/**
 * Worker handler — runs every 5 minutes. Flips eligible captured charges to
 * `settlement_released_at = now()`. The actual fund movement happens in
 * Razorpay's settlement cycle; this row is our internal reconciliation flag.
 * Returns the number of rows released.
 */
export async function releaseDueSettlements(): Promise<number> {
  const released = await db
    .update(payments)
    .set({ settlementReleasedAt: sql`now()` })
    .where(
      and(
        eq(payments.kind, 'charge'),
        eq(payments.status, 'captured'),
        isNull(payments.settlementReleasedAt),
        sql`${payments.settlementHoldUntil} is not null`,
        sql`${payments.settlementHoldUntil} <= now()`,
      ),
    )
    .returning({ id: payments.id });

  return released.length;
}
