import type { FastifyPluginAsync } from 'fastify';
import { NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getBookingById } from '../services/inventory_service.js';
import { getPayment, listForBooking } from '../services/payments_service.js';

/** Read-only payments endpoints — Phase 12. Reads work today; writes happen
 *  inside the booking flow + webhook handler. */
export const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/bookings/:bookingId/payments', { preHandler: requireAuth }, async (req) => {
    const { bookingId } = req.params as { bookingId: string };
    // The booking row carries the tenant: only its members see the ledger,
    // the same gate as GET /v1/bookings/:id.
    const booking = await getBookingById(bookingId);
    if (!booking) throw new NotFound('Booking not found', 'booking_not_found');
    const user = await currentUser(req);
    await requireTenantMembership(user.id, booking.tenantId);
    return listForBooking(bookingId, booking.tenantId);
  });

  app.get(
    '/v1/tenants/:tenantId/payments/:id',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, id } = req.params as { tenantId: string; id: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      const row = await getPayment(id, tenantId);
      if (!row) throw new NotFound('Payment not found', 'payment_not_found');
      return row;
    },
  );
};
