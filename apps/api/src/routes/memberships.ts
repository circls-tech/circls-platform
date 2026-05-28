import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  createMembership,
  getMembership,
  listMembershipsForTenant,
  purchaseMembership,
} from '../services/memberships_service.js';

const createSchema = z.object({
  venueId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  pricePaise: z.number().int().min(0),
  durationDays: z.number().int().min(1).max(3650),
  benefits: z.record(z.unknown()).optional(),
});

export const membershipRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/tenants/:tenantId/memberships', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return listMembershipsForTenant(tenantId);
  });

  app.post('/v1/tenants/:tenantId/memberships', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid membership payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    return createMembership({ tenantId, ...parsed.data });
  });

  app.get('/v1/tenants/:tenantId/memberships/:id', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    const row = await getMembership(id, tenantId);
    if (!row) throw new NotFound('Membership not found', 'membership_not_found');
    return row;
  });

  app.post('/v1/memberships/:id/purchase', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const user = await currentUser(req);
    return purchaseMembership({ membershipId: id, userId: user.id });
  });
};
