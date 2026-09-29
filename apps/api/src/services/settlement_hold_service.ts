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
 *     captured charge on a booking, based on when the purchased thing ends.
 *     Called from the webhook capture path. Accepts an optional executor so
 *     callers inside a transaction don't open a nested one.
 *   - reholdForEvent(): an event's window moved after tickets sold — recompute
 *     the hold for every still-unreleased captured charge on that event's
 *     bookings. Called from the event-update path (direct edit and approved
 *     change request) inside the writer's transaction, so the new `ends_at` and
 *     the new holds land together.
 *   - releaseDueSettlements(): worker handler — marks payments whose hold has
 *     passed as `settlement_released_at`. The actual fund movement is Razorpay's
 *     job; we just track release-eligibility for our reconciliation.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bookings, events, payments } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/** Anything that can run a drizzle UPDATE/SELECT — both `db` and a `tx` satisfy this. */
type Executor = Pick<typeof db, 'select' | 'update'>;

/**
 * The hold anchor, as SQL: a correlated subquery resolving one booking's
 * settlement hold. `bookingRef` is whatever identifies that booking in the
 * enclosing statement — a literal id for the single-booking path, or the
 * updated row's `booking_id` column for the bulk path.
 *
 * Shared by {@link holdForBooking} and {@link reholdForEvent} so capture and
 * reschedule can never compute the hold two different ways.
 */
function holdAnchorFor(bookingRef: SQL): SQL {
  const buffer = sql`(${env.SETTLEMENT_HOLD_BUFFER_MIN}::int * interval '1 minute')`;
  return sql`(
    select coalesce(
      upper(b.time_range) + ${buffer},
      e.ends_at + ${buffer},
      now() + (${env.SETTLEMENT_HOLD_FALLBACK_BUFFER_MIN}::int * interval '1 minute')
    )
    from ${bookings} b
    left join ${events} e on e.id = (b.item_data->>'eventId')::uuid
    where b.id = ${bookingRef}
  )`;
}

/**
 * Set the settlement hold on the (single, latest) captured charge for this
 * booking. The hold anchor is when the purchased thing ends, plus the buffer:
 *
 *   - slot bookings:  upper(bookings.time_range) + SETTLEMENT_HOLD_BUFFER_MIN
 *   - event bookings: events.ends_at + SETTLEMENT_HOLD_BUFFER_MIN
 *                     (no time_range; joined via item_data->>'eventId')
 *   - anything else (memberships' synthetic bookings, future item types):
 *     now() + SETTLEMENT_HOLD_FALLBACK_BUFFER_MIN (default 1 day) — no natural
 *     end, so the hold is a fixed cooling-off window after capture. A NULL
 *     hold would never be released and the money would be invisible to payout
 *     reconciliation forever.
 */
export async function holdForBooking(bookingId: string, exec: Executor = db): Promise<void> {
  const updated = await exec
    .update(payments)
    .set({ settlementHoldUntil: holdAnchorFor(sql`${bookingId}`) })
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
 * Re-anchor the settlement hold for an event whose window moved after money
 * was taken. Without this a rescheduled event keeps paying out against its
 * original end date: moved later, the partner is paid before the event has
 * happened and a refund has nothing left to claw back; moved earlier, the
 * money sits in custody past the date it should have settled. Either way the
 * revenue lands in the wrong reconciliation week, since
 * `reconcileWeeklyPayouts` grosses by `settlement_released_at`.
 *
 * Which rows move:
 *   - the three charge statuses payout reconciliation counts as gross
 *     ('captured', 'refunded', 'partially_refunded') — a charge refunded
 *     before its hold elapsed still releases, so its hold still matters;
 *   - only rows with `settlement_released_at is null`. A released charge has
 *     already been counted into a payout week; moving its hold now would not
 *     un-count it, it would only make the ledger disagree with what was paid.
 *   - only rows that already carry a hold. A NULL hold means the money never
 *     came through Route (walk-in / paid-at-venue), and payout reconciliation
 *     deliberately ignores those — this recomputes holds, it never creates one.
 *
 * Runs in the caller's transaction. Returns the number of holds moved.
 */
export async function reholdForEvent(eventId: string, exec: Executor = db): Promise<number> {
  const moved = await exec
    .update(payments)
    .set({ settlementHoldUntil: holdAnchorFor(sql`${payments.bookingId}`) })
    .where(
      and(
        eq(payments.kind, 'charge'),
        sql`${payments.status} in ('captured', 'refunded', 'partially_refunded')`,
        isNull(payments.settlementReleasedAt),
        sql`${payments.settlementHoldUntil} is not null`,
        sql`${payments.bookingId} in (
          select eb.id from ${bookings} eb
          where eb.item_type = 'event' and eb.item_data->>'eventId' = ${eventId}
        )`,
      ),
    )
    .returning({ id: payments.id });

  if (moved.length > 0) {
    logger.info({ eventId, moved: moved.length }, 'settlement_hold_reanchored');
  }

  return moved.length;
}

/**
 * Worker handler — runs every 5 minutes. Flips eligible captured charges to
 * `settlement_released_at = now()`. The actual fund movement happens in
 * Razorpay's settlement cycle; this row is our internal reconciliation flag.
 * Returns the number of rows released.
 *
 * Status filter matches payout reconciliation's gross filter: a charge that
 * was (partially) refunded before its hold elapsed must still release —
 * reconciliation counts its gross and nets the refund rows separately. Only
 * `status='captured'` would strand such charges unreleased while their
 * refunds still deduct, under-paying the venue.
 */
export async function releaseDueSettlements(): Promise<number> {
  const released = await db
    .update(payments)
    .set({ settlementReleasedAt: sql`now()` })
    .where(
      and(
        eq(payments.kind, 'charge'),
        sql`${payments.status} in ('captured', 'refunded', 'partially_refunded')`,
        isNull(payments.settlementReleasedAt),
        sql`${payments.settlementHoldUntil} is not null`,
        sql`${payments.settlementHoldUntil} <= now()`,
      ),
    )
    .returning({ id: payments.id });

  return released.length;
}
