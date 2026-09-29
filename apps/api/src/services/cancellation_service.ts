/**
 * Cancellation service — Phase 14.
 *
 * Distinct from booking_service.cancelBooking() (walk-in, no money to reverse).
 * This entry point handles paid bookings:
 *   - Looks up the booking, its charge payment row and any prior refunds.
 *   - Decides refund amount per `decideRefund()`.
 *   - Sets booking.status='cancelled' and frees the slots.
 *   - If a refund is due, delegates to refund_service.issueRefund() inside the
 *     same transaction so a failure rolls the cancel back atomically.
 *   - If the charge was never captured (unpaid pending booking), fails the
 *     charge row instead and voids the gateway order after commit so the
 *     customer's still-open card form can't complete the payment late.
 *   - Writes a 'booking.cancelled' audit row with the refund detail.
 *
 * `previewCancellation()` reads the same inputs and makes the same decision
 * without the side effects, so the portal can show the refund before it's made.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bookings, events, payments, slots, userMemberships } from '../db/schema/index.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import { getGateway, isGatewayProvider, type PaymentProviderId } from '../lib/gateway.js';
import { logger } from '../lib/logger.js';
import {
  type BookingPaymentMethod,
  type RefundDecision,
  type RefundTier,
  decideRefund,
} from './cancellation_policy.js';
import {
  type RefundExec,
  issueRefund,
  lockBookingCharges,
  selectRefundableCharge,
  sumPriorRefunds,
} from './refund_service.js';
import { revokeQrTicketsForBooking } from './qr_ticket_service.js';

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
  policy: RefundTier;
}

/** What cancelling a booking right now would refund. */
export interface RefundPreview {
  bookingId: string;
  tier: RefundTier;
  refundPaise: number;
  /** What was charged: the charge row, else the booking total. */
  amountPaise: number;
  /** Already refunded against the booking before this cancel. */
  alreadyRefundedPaise: number;
}

/** Postgres tstzrange text form looks like `["2026-..","2026-..")`. */
function parseTstzRangeStart(range: string): Date | null {
  // Strip the bracket and pull the first ISO timestamp.
  const match = range.match(/^[[(]"?([^",)]+)"?,/);
  if (!match) return null;
  const d = new Date(match[1]!);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface CancellationInputs {
  booking: typeof bookings.$inferSelect;
  charge: typeof payments.$inferSelect | undefined;
  slotStart: Date;
  alreadyRefundedPaise: number;
}

/**
 * Everything the refund decision needs, read the same way for a cancel and for
 * its preview. `lockCharge` takes the charge row FOR UPDATE (the cancel does,
 * inside its transaction).
 */
async function loadCancellationInputs(
  exec: RefundExec,
  bookingId: string,
  lockCharge: boolean,
): Promise<CancellationInputs> {
  // The cancel locks every charge of the booking before reading it, so a
  // capture on any of them (a booking can carry several after a gateway
  // switch or failover) either commits first — and the reads below see the
  // confirmed booking and captured charge — or waits for the cancel and then
  // takes applyPaymentCaptured's cancelled-booking refund.
  if (lockCharge) await lockBookingCharges(exec, bookingId);
  const [booking] = await exec.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);

  if (!booking) throw new NotFound('Booking not found', 'booking_not_found');
  if (booking.status === 'cancelled') {
    throw new Conflict('Booking already cancelled', 'already_cancelled');
  }

  // The charge the refund decision is about: the newest that took money,
  // else the newest (a booking can carry a dead charge from a gateway switch
  // or failover). Legacy walk-ins have none. The cancel already holds every
  // charge's lock (above), so no capture can flip one under our feet.
  const charge = await selectRefundableCharge(exec, bookingId, lockCharge);

  // Slot start instant. Prefer the booking's persisted `time_range` (Track A
  // fixed cancelled-booking visibility by stamping arena + span on the row);
  // fall back to a join on slots when older bookings lack it.
  let slotStart: Date | null = null;
  if (booking.timeRange) {
    slotStart = parseTstzRangeStart(booking.timeRange);
  }
  if (!slotStart) {
    const [s] = await exec
      .select({ startsAt: sql<string>`lower(${slots.timeRange})::text` })
      .from(slots)
      .where(and(eq(slots.bookingId, bookingId), sql`${slots.deletedAt} is null`))
      .orderBy(sql`lower(${slots.timeRange}) asc`)
      .limit(1);
    slotStart = s?.startsAt ? new Date(s.startsAt) : null;
  }
  // Event bookings carry no time_range and no slots — the event's start
  // instant plays the slot-start role for the refund-policy tiers.
  if (!slotStart && booking.itemType === 'event') {
    const eventId = (booking.itemData as { eventId?: string } | null)?.eventId;
    if (eventId) {
      const [ev] = await exec
        .select({ startsAt: events.startsAt })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);
      slotStart = ev?.startsAt ?? null;
    }
  }
  // Membership purchases carry no time_range and no slots either. The
  // membership's own start plays the slot-start role, so a self-cancel would
  // be scored on the same tiers; a staff refund overrides them regardless.
  if (!slotStart && booking.itemType === 'membership') {
    const [um] = await exec
      .select({ startsAt: userMemberships.startsAt })
      .from(userMemberships)
      .innerJoin(payments, eq(payments.id, userMemberships.paymentId))
      .where(eq(payments.bookingId, bookingId))
      .limit(1);
    slotStart = um?.startsAt ?? null;
  }
  // Fail-closed: cancelling without knowing the slot start would silently
  // hand a full refund. Reject loudly instead.
  if (!slotStart) {
    throw new Conflict('Cannot determine slot start time', 'no_slot_start');
  }

  const { refundedPaise } = await sumPriorRefunds(exec, bookingId, charge?.id);
  return { booking, charge, slotStart, alreadyRefundedPaise: refundedPaise };
}

function decide(inputs: CancellationInputs, bySelf: boolean): RefundDecision {
  return decideRefund({
    bookingSlotStart: inputs.slotStart,
    paymentMethod: inputs.booking.paymentMethod as BookingPaymentMethod,
    charge: inputs.charge
      ? { amountPaise: Number(inputs.charge.amountPaise), status: inputs.charge.status }
      : null,
    bookingTotalPaise: Number(inputs.booking.totalPaise ?? 0),
    alreadyRefundedPaise: inputs.alreadyRefundedPaise,
    bySelf,
  });
}

/**
 * What cancelling `bookingId` right now would refund — the same inputs and the
 * same decision as {@link cancelPaidBooking}, read without locks or side
 * effects. Throws what the cancel would (already cancelled, no slot start).
 */
export async function previewCancellation(
  bookingId: string,
  bySelf: boolean,
): Promise<RefundPreview> {
  const inputs = await loadCancellationInputs(db, bookingId, false);
  const decision = decide(inputs, bySelf);
  return {
    bookingId,
    tier: decision.tier,
    refundPaise: decision.refundPaise,
    amountPaise: decision.amountPaise,
    alreadyRefundedPaise: inputs.alreadyRefundedPaise,
  };
}

export async function cancelPaidBooking(input: CancelInput): Promise<CancelResult> {
  // Gateway orders to void after commit: every never-captured charge of the
  // cancelled booking (see below).
  let ordersToCancel: { provider: PaymentProviderId; orderId: string }[] = [];

  const result = await db.transaction(async (tx) => {
    const inputs = await loadCancellationInputs(tx as RefundExec, input.bookingId, true);
    const { booking, charge } = inputs;
    const decision = decide(inputs, input.bySelf);

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

    await revokeQrTicketsForBooking(input.bookingId, tx);

    // 2b. Never-captured charges (customer never completed payment — the
    //     card form may still be open with a retryable gateway order behind
    //     it): terminally fail every pending charge of the booking and queue
    //     their gateway orders for cancellation after commit, so a late retry
    //     can't charge the customer for a booking that no longer exists.
    //     When the decided charge itself was never captured, the decision
    //     refunds nothing ('uncaptured').
    const chargeNeverCaptured = charge?.status === 'pending';
    const failedPending = await tx
      .update(payments)
      .set({ status: 'failed' })
      .where(
        and(
          eq(payments.bookingId, input.bookingId),
          eq(payments.kind, 'charge'),
          eq(payments.status, 'pending'),
        ),
      )
      .returning({ provider: payments.provider, providerOrderId: payments.providerOrderId });
    ordersToCancel = failedPending.flatMap((c) =>
      isGatewayProvider(c.provider) && c.providerOrderId
        ? [{ provider: c.provider, orderId: c.providerOrderId }]
        : [],
    );

    // 3. Refund, if any — decideRefund only grants one against a captured
    //    charge, capped at what earlier refunds left. issueRefund() runs in its
    //    own logical block but we pass the same `tx` so a refund failure rolls
    //    the whole cancel back.
    let refundId: string | undefined;
    if (decision.refundPaise > 0) {
      const refund = await issueRefund(
        {
          bookingId: input.bookingId,
          amountPaise: decision.refundPaise,
          reason: input.reason,
          actorUserId: input.actorUserId,
          ...(charge ? { chargePaymentId: charge.id } : {}),
        },
        tx as RefundExec,
      );
      refundId = refund.paymentId;
    }

    const ctx: AuditCtx = { tenantId: booking.tenantId, actorUserId: input.actorUserId };
    await writeAudit(tx, ctx, 'booking.cancelled', 'booking', input.bookingId, null, {
      reason: input.reason,
      bySelf: input.bySelf,
      refundPaise: decision.refundPaise,
      policyTier: decision.tier,
      refundId: refundId ?? null,
      amountPaise: decision.amountPaise,
      alreadyRefundedPaise: inputs.alreadyRefundedPaise,
      paymentMethod: booking.paymentMethod,
      chargeNeverCaptured,
    });

    return {
      bookingId: input.bookingId,
      status: 'cancelled' as const,
      refundPaise: decision.refundPaise,
      ...(refundId !== undefined ? { refundId } : {}),
      policy: decision.tier,
    };
  });

  // Void the gateway orders AFTER commit — a network call doesn't belong in
  // the row-locked tx, and a gateway error must not roll back the
  // cancellation. Best-effort: if a cancel loses to a retry-capture, the
  // capture webhook's auto-refund safety net settles it. (Razorpay's adapter
  // is a documented no-op — no order-cancel API.)
  await Promise.all(
    ordersToCancel.map(async (order) => {
      try {
        await getGateway(order.provider).cancelOrder(order.orderId);
      } catch (err) {
        logger.error(
          { err, bookingId: input.bookingId, ...order },
          'cancel_booking_gateway_cancel_failed',
        );
      }
    }),
  );

  return result;
}
