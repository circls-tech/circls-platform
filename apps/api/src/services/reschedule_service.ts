/**
 * Rescheduling a slot booking: the same booking, moved to other slots.
 *
 * A partner (Owner, Manager or Staff — anyone who may cancel) moves a
 * confirmed court booking to different slots at the same venue: another
 * time, another day, another court. The booking keeps its id, customer,
 * payment and history; only its slots change. Before this the only way was
 * to refund and rebook, which costs the partner the gateway fee and the
 * customer a second payment.
 *
 * Money does not move here. The customer paid `totalPaise` for the old
 * slots; the new slots may add up to more or less, and the difference is
 * recorded (`priceDeltaPaise`, in the booking's `item_data.lastReschedule`
 * and the audit row) for the partner to settle at the counter — a top-up
 * taken there, or a goodwill shortfall. The booking's own total stays what
 * was actually paid, so refunds and payouts keep reconciling.
 *
 * What moves with the slots, inside one transaction:
 *   - the slots themselves: the old ones go back to `open`, the new ones are
 *     claimed with the same predicate as a fresh booking (open, or an own /
 *     expired hold; never one that has started);
 *   - the booking's arena and time span (`slot_arena_id`, `time_range`), so
 *     every read that falls back to the booking row sees the new window —
 *     and the arena overlap constraint still guards the new span;
 *   - the settlement hold on its captured charge, re-anchored to the new end
 *     (see settlement_hold_service.reholdForBooking);
 *   - QR entry passes: the old ones are revoked and fresh ones issued over
 *     the new span, when the arena issues them.
 * After commit the customer is told and their reminders are re-queued
 * (notification_hooks.onBookingRescheduled).
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { arenas, bookings, payments, slots } from '../db/schema/index.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import { onBookingRescheduled } from './notification_hooks.js';
import { issueQrTicketsForBooking, revokeQrTicketsForBooking } from './qr_ticket_service.js';
import { reholdForBooking } from './settlement_hold_service.js';

export interface RescheduleInput {
  bookingId: string;
  /** The slots the booking moves to: one arena, same venue, all still ahead. */
  slotIds: string[];
  actorUserId: string;
  reason: string;
  /** The price difference was settled at the counter as part of the move. */
  settleNow?: boolean;
}

export interface RescheduleResult {
  bookingId: string;
  status: 'confirmed';
  arenaId: string;
  fromSlotIds: string[];
  toSlotIds: string[];
  /** ISO-8601: the new span. */
  startAt: string;
  endAt: string;
  /** What the customer paid, unchanged. */
  paidPaise: number;
  /** What the new slots add up to. */
  newTotalPaise: number;
  /** newTotal - paid: positive = to collect at the venue, negative = owed back. */
  priceDeltaPaise: number;
  /** When the difference was settled at the counter, if it has been. */
  settledAt: string | null;
}

/** How a reschedule is remembered on the booking row (`item_data`). */
export interface RescheduleRecord {
  at: string;
  byUserId: string;
  reason: string;
  fromSlotIds: string[];
  toSlotIds: string[];
  fromArenaId: string | null;
  toArenaId: string;
  priceDeltaPaise: number;
  /** Set once the partner records the difference as settled at the counter;
   *  the matching `adjustment` ledger row is `settledPaymentId`. */
  settledAt?: string;
  settledPaymentId?: string;
}

export interface SettleResult {
  bookingId: string;
  paymentId: string;
  /** Signed: positive = collected from the customer, negative = handed back. */
  amountPaise: number;
  settledAt: string;
}

export async function rescheduleBooking(input: RescheduleInput): Promise<RescheduleResult> {
  const uniqueSlotIds = [...new Set(input.slotIds)];
  if (uniqueSlotIds.length === 0) throw new Conflict('No slots selected', 'no_slots');

  const result = await db.transaction(async (tx) => {
    // Lock the booking so two reschedules (or a reschedule and a cancel)
    // cannot race over the same slots.
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, input.bookingId))
      .for('update');
    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');
    if (booking.itemType !== 'slot') {
      throw new Conflict('Only court bookings can be rescheduled', 'not_a_slot_booking');
    }
    if (booking.status !== 'confirmed') {
      throw new Conflict(`A ${booking.status} booking cannot be rescheduled`, 'booking_not_confirmed');
    }
    if (!booking.venueId) throw new Conflict('Booking has no venue', 'booking_without_venue');

    // The slots it holds now. A booking that has started is not moved: its
    // slots are being played, and a customer who did not turn up is a no-show.
    const current = await tx
      .select({
        id: slots.id,
        arenaId: slots.arenaId,
        pricePaise: slots.pricePaise,
        started: sql<boolean>`lower(${slots.timeRange}) <= now()`,
      })
      .from(slots)
      .where(and(eq(slots.bookingId, booking.id), sql`${slots.deletedAt} is null`));
    if (current.length === 0) throw new Conflict('Booking holds no slots', 'no_current_slots');
    if (current.some((s) => s.started)) {
      throw new Conflict('This booking has already started', 'booking_started');
    }
    const fromSlotIds = current.map((s) => s.id);
    const fromArenaId = booking.slotArenaId ?? current[0]!.arenaId;

    // The slots it moves to: this organisation's, at this venue, on one
    // arena, none already begun. Anything else reads as absent or refused.
    const target = await tx
      .select({
        id: slots.id,
        arenaId: slots.arenaId,
        venueId: arenas.venueId,
        pricePaise: slots.pricePaise,
        started: sql<boolean>`lower(${slots.timeRange}) <= now()`,
      })
      .from(slots)
      .innerJoin(arenas, eq(arenas.id, slots.arenaId))
      .where(
        and(
          inArray(slots.id, uniqueSlotIds),
          eq(slots.tenantId, booking.tenantId),
          sql`${slots.deletedAt} is null`,
        ),
      );
    if (target.length !== uniqueSlotIds.length) throw new NotFound('Slot not found', 'slot_not_found');
    if (target.some((s) => s.venueId !== booking.venueId)) {
      throw new Conflict('Slots belong to another venue', 'mixed_venue_slots');
    }
    const toArenaId = target[0]!.arenaId;
    if (!target.every((s) => s.arenaId === toArenaId)) {
      throw new Conflict('Multi-arena booking not supported', 'multi_arena_booking');
    }
    if (target.some((s) => s.started)) {
      throw new Conflict('This slot has already started', 'slot_in_past');
    }
    const sameSlots =
      target.length === current.length && target.every((s) => fromSlotIds.includes(s.id));
    if (sameSlots) throw new Conflict('Those are the slots it already has', 'same_slots');

    // 1. Give the old slots back first, so a move that overlaps them (an
    //    hour later on the same court) can claim them again below.
    await tx
      .update(slots)
      .set({ status: 'open', bookingId: null })
      .where(and(eq(slots.bookingId, booking.id), sql`${slots.deletedAt} is null`));

    // 2. Claim the new ones atomically — the same predicate as a fresh
    //    booking. A short count means someone got there first; the
    //    transaction rolls back and the old slots are the booking's again.
    const claimed = await tx
      .update(slots)
      .set({ status: 'booked', bookingId: booking.id, holdExpiresAt: null, heldByUserId: null })
      .where(
        and(
          inArray(slots.id, uniqueSlotIds),
          eq(slots.tenantId, booking.tenantId),
          sql`${slots.deletedAt} is null`,
          sql`lower(${slots.timeRange}) > now()`,
          or(
            eq(slots.status, 'open'),
            and(
              eq(slots.status, 'held'),
              or(eq(slots.heldByUserId, input.actorUserId), sql`${slots.holdExpiresAt} < now()`),
            ),
          ),
        ),
      )
      .returning({ id: slots.id, pricePaise: slots.pricePaise });
    if (claimed.length !== uniqueSlotIds.length) {
      throw new Conflict('Slot already taken', 'slot_taken');
    }

    const paidPaise = Number(booking.totalPaise ?? 0);
    const newTotalPaise = claimed.reduce((s, r) => s + Number(r.pricePaise), 0);
    const priceDeltaPaise = newTotalPaise - paidPaise;
    const record: RescheduleRecord = {
      at: new Date().toISOString(),
      byUserId: input.actorUserId,
      reason: input.reason,
      fromSlotIds,
      toSlotIds: uniqueSlotIds,
      fromArenaId,
      toArenaId,
      priceDeltaPaise,
    };

    // 3. The booking's own arena and span follow the slots, as on create.
    const itemData = { ...(booking.itemData ?? {}), lastReschedule: record };
    const [updated] = await tx
      .update(bookings)
      .set({
        slotArenaId: toArenaId,
        timeRange: sql`(select tstzrange(min(lower(time_range)), max(upper(time_range)), '[)') from slots where booking_id = ${booking.id})`,
        itemData,
      })
      .where(eq(bookings.id, booking.id))
      .returning({ timeRange: bookings.timeRange });

    // 3b. The difference changed hands at the counter as part of the move.
    let settledAt: string | null = null;
    if (input.settleNow && priceDeltaPaise !== 0) {
      settledAt = (await settleDifferenceLocked(tx, { ...booking, itemData }, input.actorUserId)).settledAt;
    }

    // 4. Money held for this booking settles after the NEW end, not the old.
    await reholdForBooking(booking.id, tx);

    // 5. Entry passes cover a span; the old ones no longer describe it.
    await revokeQrTicketsForBooking(booking.id, tx);
    await issueQrTicketsForBooking(booking.id, tx);

    const ctx: AuditCtx = { tenantId: booking.tenantId, actorUserId: input.actorUserId };
    await writeAudit(
      tx,
      ctx,
      'booking.rescheduled',
      'booking',
      booking.id,
      { slotIds: fromSlotIds, arenaId: fromArenaId, timeRange: booking.timeRange },
      { slotIds: uniqueSlotIds, arenaId: toArenaId, timeRange: updated?.timeRange ?? null, reason: input.reason, paidPaise, newTotalPaise, priceDeltaPaise },
    );

    const span = parseRange(updated?.timeRange ?? null);
    return {
      bookingId: booking.id,
      status: 'confirmed' as const,
      arenaId: toArenaId,
      fromSlotIds,
      toSlotIds: uniqueSlotIds,
      startAt: span.start,
      endAt: span.end,
      paidPaise,
      newTotalPaise,
      priceDeltaPaise,
      settledAt,
    };
  });

  // Outside the transaction: best-effort, never fails the move.
  await onBookingRescheduled(result.bookingId);
  return result;
}

/** `["2026-10-20 10:00:00+00","2026-10-20 11:00:00+00")` → ISO bounds. */
function parseRange(range: string | null): { start: string; end: string } {
  const m = range ? /^[[(]"?([^",]+)"?,"?([^")]+)"?[\])]$/.exec(range) : null;
  const start = m ? new Date(m[1]!) : null;
  const end = m ? new Date(m[2]!) : null;
  return {
    start: start && !Number.isNaN(start.getTime()) ? start.toISOString() : '',
    end: end && !Number.isNaN(end.getTime()) ? end.toISOString() : '',
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Record that the price difference of the last reschedule changed hands at
 * the counter: an `adjustment` ledger row (provider `external`, so payouts
 * and analytics — which count gateway charges only — leave it alone) and a
 * settled stamp on the record. Once per reschedule.
 */
async function settleDifferenceLocked(
  tx: Tx,
  booking: { id: string; tenantId: string; currency: string; itemData: Record<string, unknown> | null },
  actorUserId: string,
): Promise<SettleResult> {
  const record = (booking.itemData?.['lastReschedule'] as RescheduleRecord | undefined) ?? null;
  if (!record) throw new Conflict('This booking has not been rescheduled', 'no_reschedule');
  if (record.settledAt) throw new Conflict('The difference is already settled', 'already_settled');
  if (record.priceDeltaPaise === 0) throw new Conflict('There is no difference to settle', 'no_difference');

  const settledAt = new Date().toISOString();
  const [row] = await tx
    .insert(payments)
    .values({
      bookingId: booking.id,
      tenantId: booking.tenantId,
      provider: 'external',
      amountPaise: record.priceDeltaPaise,
      currency: booking.currency,
      status: 'captured',
      kind: 'adjustment',
      metadata: { reason: 'reschedule_difference', rescheduledAt: record.at, settledByUserId: actorUserId },
    })
    .returning({ id: payments.id });
  const settled: RescheduleRecord = { ...record, settledAt, settledPaymentId: row!.id };
  await tx
    .update(bookings)
    .set({ itemData: { ...(booking.itemData ?? {}), lastReschedule: settled } })
    .where(eq(bookings.id, booking.id));
  await writeAudit(
    tx,
    { tenantId: booking.tenantId, actorUserId },
    'booking.reschedule_settled',
    'booking',
    booking.id,
    null,
    { amountPaise: record.priceDeltaPaise, paymentId: row!.id, rescheduledAt: record.at },
  );
  return { bookingId: booking.id, paymentId: row!.id, amountPaise: record.priceDeltaPaise, settledAt };
}

/** The partner records, after the fact, that the difference changed hands. */
export async function settleRescheduleDifference(input: {
  bookingId: string;
  actorUserId: string;
}): Promise<SettleResult> {
  return db.transaction(async (tx) => {
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, input.bookingId))
      .for('update');
    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');
    return settleDifferenceLocked(tx, booking, input.actorUserId);
  });
}
