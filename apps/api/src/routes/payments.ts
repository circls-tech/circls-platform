import type { FastifyPluginAsync } from 'fastify';
import { NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getPayment, listForBooking } from '../services/payments_service.js';

/** Read-only payments endpoints — Phase 12. Reads work today; writes happen
 *  inside the booking flow + webhook handler. */
export const paymentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/bookings/:bookingId/payments', { preHandler: requireAuth }, async (req) => {
    const { bookingId } = req.params as { bookingId: string };
    // Tenant scoping happens via the booking row; payments inherit it.
    return listForBooking(bookingId);
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
