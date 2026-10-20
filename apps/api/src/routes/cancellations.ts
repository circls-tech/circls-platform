import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { cancelPaidBooking, previewCancellation } from '../services/cancellation_service.js';
import { getBookingById } from '../services/inventory_service.js';
import { rescheduleBooking, settleRescheduleDifference } from '../services/reschedule_service.js';

const rescheduleBodySchema = z.object({
  /** The slots the booking moves to: one arena at the same venue. */
  slotIds: z.array(z.string().uuid()).min(1).max(48),
  reason: z.string().min(1).max(500).optional(),
  /** The price difference was settled at the counter as part of the move. */
  settleNow: z.boolean().optional(),
});

const cancelBodySchema = z.object({
  // Reason is optional — walk-in cancels (paymentMethod='external') need no
  // refund reasoning. Paid cancels usually carry one for the audit trail.
  reason: z.string().min(1).max(500).optional(),
});

/**
 * Caller-classification: the booking's own customer (`bySelf` — the timing
 * tiers apply), or a tenant member with `bookings.cancel` acting on their
 * behalf (a full, out-of-policy refund)? Neither → 403, a Read-only member
 * included. The cancel and its preview both classify here, so the preview
 * can't score the caller differently.
 */
async function isCancellingOwnBooking(
  booking: { customerUserId: string | null; tenantId: string },
  userId: string,
): Promise<boolean> {
  if (booking.customerUserId === userId) return true;

  const ctx = await requireTenantMembership(userId, booking.tenantId);
  assertCap(ctx, 'bookings.cancel');
  return false;
}

/**
 * POST /v1/bookings/:id/cancel
 *
 * Two callers:
 *   - Customer cancels their own booking            → bySelf=true.  Refund
 *     amount is decided by `computeRefundPolicy()` against the slot start.
 *   - Tenant staff/admin cancels on behalf of a customer → bySelf=false.
 *     Out-of-policy: refund is full regardless of timing. Audit captures this.
 *     Owner, Manager and Staff hold `bookings.cancel`; Read-only doesn't.
 *
 * Either way `decideRefund()` bounds it by the money actually held: nothing for
 * a charge that was never captured, and no more than earlier refunds left.
 * Walk-in (paymentMethod='external') and free bookings get refundPaise=0;
 * the engine still flips the booking to 'cancelled' and frees the slots.
 *
 * POST /v1/bookings/:id/reschedule
 *
 * A tenant member with `bookings.cancel` (Owner, Manager, Staff) moves a
 * confirmed court booking to other slots at its venue — see
 * services/reschedule_service.ts. Customers cannot reschedule themselves
 * (they ask the venue, as before); the booking's own customer gets no special
 * standing here. Money does not move: the price difference is recorded for
 * the counter.
 *
 * GET /v1/bookings/:id/refund-preview
 *
 * What the POST would refund if this caller made it now: the same
 * classification, inputs and decision, with no side effects. 409s where the
 * cancel would (already cancelled, no slot start).
 */
export const cancellationRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v1/bookings/:id/cancel', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body ?? {};
    const parsed = cancelBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequest('Invalid cancellation payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    }

    const booking = await getBookingById(id);
    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');

    const user = await currentUser(req);
    const bySelf = await isCancellingOwnBooking(booking, user.id);

    return cancelPaidBooking({
      bookingId: id,
      actorUserId: user.id,
      reason: parsed.data.reason ?? (bySelf ? 'Cancelled by customer' : 'Cancelled by venue'),
      bySelf,
    });
  });

  app.post('/v1/bookings/:id/reschedule', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = rescheduleBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new BadRequest('Invalid reschedule payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    }

    const booking = await getBookingById(id);
    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');

    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, booking.tenantId);
    assertCap(ctx, 'bookings.cancel');

    return rescheduleBooking({
      bookingId: id,
      slotIds: parsed.data.slotIds,
      actorUserId: user.id,
      reason: parsed.data.reason ?? 'Rescheduled by venue',
      ...(parsed.data.settleNow !== undefined ? { settleNow: parsed.data.settleNow } : {}),
    });
  });

  // ── POST /v1/bookings/:id/reschedule/settle ────────────────────────────────
  // The partner records that the last reschedule's price difference changed
  // hands at the counter (an `adjustment` ledger row). Same right as moving it.
  app.post('/v1/bookings/:id/reschedule/settle', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const booking = await getBookingById(id);
    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, booking.tenantId);
    assertCap(ctx, 'bookings.cancel');
    return settleRescheduleDifference({ bookingId: id, actorUserId: user.id });
  });

  app.get('/v1/bookings/:id/refund-preview', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };

    const booking = await getBookingById(id);
    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');

    const user = await currentUser(req);
    const bySelf = await isCancellingOwnBooking(booking, user.id);

    return previewCancellation(id, bySelf);
  });
};
