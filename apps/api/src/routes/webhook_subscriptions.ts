import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
} from '../services/webhook_subscriptions_service.js';

const createSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)).min(1),
});

export const webhookSubscriptionRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/tenants/:tenantId/webhook-subscriptions',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      return listSubscriptions(tenantId);
    },
  );

  app.post(
    '/v1/tenants/:tenantId/webhook-subscriptions',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId } = req.params as { tenantId: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success)
        throw new BadRequest('Invalid webhook payload', 'bad_request', {
          issues: parsed.error.issues,
        });
      return createSubscription({ tenantId, ...parsed.data });
    },
  );

  app.delete(
    '/v1/tenants/:tenantId/webhook-subscriptions/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenantId, id } = req.params as { tenantId: string; id: string };
      const user = await currentUser(req);
      await requireTenantMembership(user.id, tenantId);
      await deleteSubscription(id, tenantId);
      return reply.status(204).send();
    },
  );
};
