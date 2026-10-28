import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { assertSuperAdmin } from '../lib/authz/super_admin.js';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { listOrgsAskingForHelp, visitPartnerOrg } from '../services/super_admin_service.js';

const searchSchema = z.object({ q: z.string().max(200).optional() });

/**
 * Circls super admins open partner orgs in the partner portal — the ones that
 * have let Circls in. Everything they then do there goes through the
 * ordinary org routes, which let them in via requireTenantMembership.
 */
export const superAdminRoutes: FastifyPluginAsync = async (app) => {
  // The partner orgs asking for help right now (optionally filtered by name).
  app.get('/v1/super-admin/tenants', { preHandler: requireAuth }, async (req) => {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid search', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    await assertSuperAdmin(user.id);
    return listOrgsAskingForHelp(parsed.data.q);
  });

  // Open one: logs the visit on the org's audit log, returns its org-list row.
  // The portal calls it whenever it loads the org, so it is a POST.
  app.post('/v1/super-admin/tenants/:id/visit', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      throw new BadRequest('Invalid organisation id', 'bad_request');
    }
    const user = await currentUser(req);
    await assertSuperAdmin(user.id);
    return visitPartnerOrg(user.id, id);
  });
};
