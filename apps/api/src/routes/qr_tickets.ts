import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { assertTenantActive } from '../middleware/require_cap.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { validateQrTicket } from '../services/qr_ticket_service.js';

const validateSchema = z.object({
  code: z.string().min(1).max(200),
  /** false = peek without spending a scan (default true). */
  consume: z.boolean().optional(),
});

/**
 * Door check-in: validate (and by default consume) a scanned QR ticket. Any
 * member of the tenant can scan, Read-only included, so no capability gates
 * it; a suspended tenant can still look a pass up but not admit anyone. Codes
 * from other tenants read as not_found, so the endpoint can't be used to probe
 * foreign tickets.
 */
export const qrTicketRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/tenants/:tenantId/qr-tickets/validate',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      const parsed = validateSchema.safeParse(req.body);
      if (!parsed.success)
        throw new BadRequest('Invalid scan payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      if (parsed.data.consume ?? true) assertTenantActive(ctx);
      return validateQrTicket({ tenantId, actorUserId: user.id }, parsed.data.code, {
        consume: parsed.data.consume ?? true,
      });
    },
  );
};
