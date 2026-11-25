import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  CUSTOMER_SEARCH_MAX_LIMIT,
  CUSTOMER_SEARCH_MIN_QUERY,
  searchCustomers,
} from '../services/customers_service.js';

const searchQuerySchema = z.object({
  q: z.string().trim().min(CUSTOMER_SEARCH_MIN_QUERY).max(200),
  limit: z.coerce.number().int().min(1).max(CUSTOMER_SEARCH_MAX_LIMIT).optional(),
});

/**
 * Customer lookup for the partner portal's desk forms (reception booking, Add
 * registration, Add member): type a name or a phone number, pick the person,
 * and their details are filled in instead of typed again.
 *
 * Gated on bookings.create — the capability those forms need — rather than
 * membership alone: the only reason to look a customer up here is to record
 * something for them.
 */
export const customerRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/tenants/:tenantId/customers', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'bookings.create');

    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid customer search', 'bad_request', {
        issues: parsed.error.issues,
      });
    }
    const { q, limit } = parsed.data;
    return { customers: await searchCustomers(tenantId, q, limit) };
  });
};
