import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tenantMembers } from '../db/schema/index.js';
import { BadRequest, Forbidden, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { cancelPaidBooking } from '../services/cancellation_service.js';
import { getBookingById } from '../services/inventory_service.js';

const cancelBodySchema = z.object({
  // Reason is optional — walk-in cancels (paymentMethod='external') need no
  // refund reasoning. Paid cancels usually carry one for the audit trail.
  reason: z.string().min(1).max(500).optional(),
});

/**
 * POST /v1/bookings/:id/cancel
 *
 * Two callers:
 *   - Customer cancels their own booking            → bySelf=true.  Refund
 *     amount is decided by `computeRefundPolicy()` against the slot start.
 *   - Tenant staff/admin cancels on behalf of a customer → bySelf=false.
 *     Out-of-policy: refund is full regardless of timing. Audit captures this.
 *
 * Walk-in (paymentMethod='external') and free bookings get refundPaise=0;
 * the engine still flips the booking to 'cancelled' and frees the slots.
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

    // Caller-classification: customer themselves, or a tenant member acting on
    // their behalf? Neither → 403.
    const bySelf = booking.customerUserId === user.id;

    if (!bySelf) {
      const [member] = await db
        .select()
        .from(tenantMembers)
        .where(
          and(
            eq(tenantMembers.userId, user.id),
            eq(tenantMembers.tenantId, booking.tenantId),
          ),
        )
        .limit(1);
      if (!member) {
        throw new Forbidden('Not authorised to cancel this booking', 'tenant_forbidden');
      }
    }

    return cancelPaidBooking({
      bookingId: id,
      actorUserId: user.id,
      reason: parsed.data.reason ?? (bySelf ? 'Cancelled by customer' : 'Cancelled by venue'),
      bySelf,
    });
  });
};
