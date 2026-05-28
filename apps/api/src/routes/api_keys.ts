import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/api_keys_service.js';

const createSchema = z.object({
  name: z.string().min(1).max(200),
  role: z.enum(['read', 'write', 'admin']),
  scopes: z.array(z.string().min(1)).max(50).optional(),
});

export const apiKeyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/tenants/:tenantId/api-keys', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return listApiKeys(tenantId);
  });

  app.post('/v1/tenants/:tenantId/api-keys', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid api-key payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    return createApiKey({ tenantId, actorUserId: user.id, ...parsed.data });
  });

  app.delete(
    '/v1/tenants/:tenantId/api-keys/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenantId, id } = req.params as { tenantId: string; id: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      await revokeApiKey(id, tenantId, user.id);
      return reply.status(204).send();
    },
  );
};
