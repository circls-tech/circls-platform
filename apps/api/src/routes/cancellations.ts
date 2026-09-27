import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { cancelPaidBooking, previewCancellation } from '../services/cancellation_service.js';
import { getBookingById } from '../services/inventory_service.js';

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

  app.get('/v1/bookings/:id/refund-preview', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };

    const booking = await getBookingById(id);
    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');

    const user = await currentUser(req);
    const bySelf = await isCancellingOwnBooking(booking, user.id);

    return previewCancellation(id, bySelf);
  });
};
