/**
 * Cancellation service — Phase 14.
 *
 * Distinct from booking_service.cancelBooking() (walk-in, no money to reverse).
 * This entry point handles paid bookings:
 *   - Looks up the booking + its charge payment row.
 *   - Decides refund amount per `computeRefundPolicy()`.
 *   - Sets booking.status='cancelled' and frees the slots.
 *   - If a refund is due, delegates to refund_service.issueRefund() inside the
 *     same transaction so a failure rolls the cancel back atomically.
 *   - Writes a 'booking.cancelled' audit row with the refund detail.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bookings, payments, slots } from '../db/schema/index.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import {
  type BookingPaymentMethod,
  type RefundPolicy,
  computeRefundPolicy,
} from './cancellation_policy.js';
import { type RefundExec, issueRefund } from './refund_service.js';

export interface CancelInput {
  bookingId: string;
  actorUserId: string;
  reason: string;
  /** True when the actor is the customer themselves (vs. venue staff / admin). */
  bySelf: boolean;
}

export interface CancelResult {
  bookingId: string;
  status: 'cancelled';
  refundPaise: number;
  refundId?: string;
  policy: RefundPolicy['tier'];
}

/** Postgres tstzrange text form looks like `["2026-..","2026-..")`. */
function parseTstzRangeStart(range: string): Date | null {
  // Strip the bracket and pull the first ISO timestamp.
  const match = range.match(/^[[(]"?([^",)]+)"?,/);
  if (!match) return null;
  const d = new Date(match[1]!);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function cancelPaidBooking(input: CancelInput): Promise<CancelResult> {
  return db.transaction(async (tx) => {
    const [booking] = await tx
      .select()
      .from(bookings)
      .where(eq(bookings.id, input.bookingId))
      .limit(1);

    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');
    if (booking.status === 'cancelled') {
      throw new Conflict('Booking already cancelled', 'already_cancelled');
    }

    // Most-recent charge payment row, if any. Phase 12 inserts one per booking;
    // legacy walk-ins have none.
    const [charge] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.bookingId, input.bookingId), eq(payments.kind, 'charge')))
      .orderBy(sql`${payments.createdAt} desc`)
      .limit(1);

    // Slot start instant. Prefer the booking's persisted `time_range` (Track A
    // fixed cancelled-booking visibility by stamping arena + span on the row);
    // fall back to a join on slots when older bookings lack it.
    let slotStart: Date | null = null;
    if (booking.timeRange) {
      slotStart = parseTstzRangeStart(booking.timeRange);
    }
    if (!slotStart) {
      const [s] = await tx
        .select({ startsAt: sql<string>`lower(${slots.timeRange})::text` })
        .from(slots)
        .where(and(eq(slots.bookingId, input.bookingId), sql`${slots.deletedAt} is null`))
        .orderBy(sql`lower(${slots.timeRange}) asc`)
        .limit(1);
      slotStart = s?.startsAt ? new Date(s.startsAt) : null;
    }
    // Fail-closed: cancelling without knowing the slot start would silently
    // hand a full refund. Reject loudly instead.
    if (!slotStart) {
      throw new Conflict('Cannot determine slot start time', 'no_slot_start');
    }

    const paymentMethod = booking.paymentMethod as BookingPaymentMethod;
    const amountPaise = charge?.amountPaise ?? Number(booking.totalPaise ?? 0);
    const policy = computeRefundPolicy(slotStart, paymentMethod, amountPaise, input.bySelf);

    // 1. Flip booking status. Use a status guard so concurrent cancels don't
    //    fire two refunds for the same booking.
    const [updated] = await tx
      .update(bookings)
      .set({ status: 'cancelled' })
      .where(and(eq(bookings.id, input.bookingId), sql`${bookings.status} <> 'cancelled'`))
      .returning();

    if (!updated) {
      throw new Conflict('Booking already cancelled', 'already_cancelled');
    }

    // 2. Free the slots — but keep slot.booking_id linkage off so subsequent
    //    rebooking can claim them. (Track A's booking row already persists the
    //    arena + time_range, so reads still see the cancelled booking.)
    await tx
      .update(slots)
      .set({ status: 'open', bookingId: null })
      .where(and(eq(slots.bookingId, input.bookingId), sql`${slots.deletedAt} is null`));

    // 3. Refund, if any. issueRefund() runs in its own logical block but we
    //    pass the same `tx` so a refund failure rolls the whole cancel back.
    let refundId: string | undefined;
    if (policy.refundPaise > 0 && charge) {
      const refund = await issueRefund(
        {
          bookingId: input.bookingId,
          amountPaise: policy.refundPaise,
          reason: input.reason,
          actorUserId: input.actorUserId,
        },
        tx as RefundExec,
      );
      refundId = refund.paymentId;
    }

    const ctx: AuditCtx = { tenantId: booking.tenantId, actorUserId: input.actorUserId };
    await writeAudit(tx, ctx, 'booking.cancelled', 'booking', input.bookingId, null, {
      reason: input.reason,
      bySelf: input.bySelf,
      refundPaise: policy.refundPaise,
      policyTier: policy.tier,
      refundId: refundId ?? null,
      amountPaise,
      paymentMethod,
    });

    return {
      bookingId: input.bookingId,
      status: 'cancelled',
      refundPaise: policy.refundPaise,
      ...(refundId !== undefined ? { refundId } : {}),
      policy: policy.tier,
    };
  });
}
