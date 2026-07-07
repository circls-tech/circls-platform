import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { validateQrTicket } from '../services/qr_ticket_service.js';

const validateSchema = z.object({
  code: z.string().min(1).max(200),
  /** false = peek without spending a scan (default true). */
  consume: z.boolean().optional(),
});

/**
 * Door check-in: validate (and by default consume) a scanned QR ticket. Any
 * member of the tenant can scan — mirrors the bookings routes, which gate on
 * tenant membership without a finer capability. Codes from other tenants read
 * as not_found, so the endpoint can't be used to probe foreign tickets.
 */
export const qrTicketRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/tenants/:tenantId/qr-tickets/validate',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      const parsed = validateSchema.safeParse(req.body);
      if (!parsed.success)
        throw new BadRequest('Invalid scan payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      return validateQrTicket({ tenantId, actorUserId: user.id }, parsed.data.code, {
        consume: parsed.data.consume ?? true,
      });
    },
  );
};
