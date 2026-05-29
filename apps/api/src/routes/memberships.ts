import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  createMembership,
  getMembership,
  listMembershipPurchases,
  listMembershipsForTenant,
  listUserMemberships,
  purchaseMembership,
  setMembershipActive,
  updateMembership,
} from '../services/memberships_service.js';

const createSchema = z.object({
  venueId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  pricePaise: z.number().int().min(0),
  durationDays: z.number().int().min(1).max(3650),
  benefits: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  venueId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  pricePaise: z.number().int().min(0).optional(),
  durationDays: z.number().int().min(1).max(3650).optional(),
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
    return createMembership({
      tenantId,
      actorUserId: user.id,
      venueId: parsed.data.venueId,
      name: parsed.data.name,
      description: parsed.data.description,
      pricePaise: parsed.data.pricePaise,
      durationDays: parsed.data.durationDays,
      benefits: parsed.data.benefits,
    });
  });

  app.get('/v1/tenants/:tenantId/memberships/:id', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    const row = await getMembership(id, tenantId);
    if (!row) throw new NotFound('Membership not found', 'membership_not_found');
    return row;
  });

  app.patch('/v1/tenants/:tenantId/memberships/:id', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid membership patch', 'bad_request', { issues: parsed.error.issues });
    const patch: Parameters<typeof updateMembership>[2] = {};
    if (parsed.data.venueId !== undefined) patch.venueId = parsed.data.venueId;
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.pricePaise !== undefined) patch.pricePaise = parsed.data.pricePaise;
    if (parsed.data.durationDays !== undefined) patch.durationDays = parsed.data.durationDays;
    if (parsed.data.benefits !== undefined) patch.benefits = parsed.data.benefits;
    return updateMembership({ tenantId, actorUserId: user.id }, id, patch);
  });

  app.post('/v1/tenants/:tenantId/memberships/:id/activate', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return setMembershipActive({ tenantId, actorUserId: user.id }, id, true);
  });

  app.post('/v1/tenants/:tenantId/memberships/:id/deactivate', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return setMembershipActive({ tenantId, actorUserId: user.id }, id, false);
  });

  // Partner-facing: buyers of a membership.
  app.get('/v1/tenants/:tenantId/memberships/:id/purchases', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return { rows: await listMembershipPurchases(tenantId, id) };
  });

  app.post('/v1/memberships/:id/purchase', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const user = await currentUser(req);
    return purchaseMembership({ membershipId: id, userId: user.id });
  });

  // Current user's active memberships (across tenants).
  app.get('/v1/users/me/memberships', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return listUserMemberships(user.id);
  });
};
