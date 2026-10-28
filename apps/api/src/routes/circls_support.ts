import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  circlsSupportStatus,
  endCirclsSupport,
  grantCirclsSupport,
} from '../services/circls_support_service.js';

const grantSchema = z.object({
  note: z
    .string()
    .trim()
    .max(500)
    .transform((s) => (s.length === 0 ? null : s))
    .nullable()
    .optional(),
});

/**
 * "Get help from Circls": an org lets Circls super admins into its portal for
 * a few hours, and can remove them sooner. Asking is like inviting someone
 * (members.invite), ending it like removing them (members.remove).
 */
export const circlsSupportRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/tenants/:tenantId/circls-support', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'members.read');
    return circlsSupportStatus(tenantId);
  });

  app.post('/v1/tenants/:tenantId/circls-support', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const parsed = grantSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new BadRequest('Invalid request', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'members.invite');
    return grantCirclsSupport({ tenantId, userId: user.id, note: parsed.data.note ?? null });
  });

  app.delete('/v1/tenants/:tenantId/circls-support', { preHandler: requireAuth }, async (req, reply) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'members.remove');
    await endCirclsSupport({ tenantId, userId: user.id });
    return reply.status(204).send();
  });
};
