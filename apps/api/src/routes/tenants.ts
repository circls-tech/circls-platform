import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAdmin } from '../middleware/require_admin.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getAnalytics } from '../services/analytics_service.js';
import { createTenant, listAllTenants, listTenantsForUser } from '../services/tenant_service.js';

const createTenantSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with dashes'),
  legalEntityName: z.string().max(200).optional(),
  gstin: z.string().max(20).optional(),
});

export const tenantRoutes: FastifyPluginAsync = async (app) => {
  // Partner: create a tenant (creator becomes owner).
  app.post('/v1/tenants', { preHandler: requireAuth }, async (req) => {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid tenant payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const { name, slug, legalEntityName, gstin } = parsed.data;
    return createTenant(user.id, {
      name,
      slug,
      legalEntityName: legalEntityName ?? null,
      gstin: gstin ?? null,
    });
  });

  // Partner: tenants the caller belongs to.
  app.get('/v1/me/tenants', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return listTenantsForUser(user.id);
  });

  // Admin: every tenant on the platform.
  app.get('/v1/tenants', { preHandler: [requireAuth, requireAdmin] }, async () => {
    return listAllTenants();
  });

  // Partner: tenant-scoped, slot-based analytics (today + trailing 7 days, IST).
  app.get('/v1/tenants/:tenantId/analytics', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return getAnalytics(tenantId);
  });
};
