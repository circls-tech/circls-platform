import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import type { Capability } from '../lib/authz/capabilities.js';
import { BadRequest, NotFound } from '../lib/errors.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { LISTING_TYPES } from '../services/listing_service.js';
import {
  createListingPreview,
  PREVIEW_TYPES,
  resolvePreviewTarget,
} from '../services/listing_preview_service.js';

/**
 * Mint "see it as a customer" preview links for listings that are not (yet)
 * public — see services/listing_preview_service.ts. Two callers:
 *
 *   - a partner, for their own venue / event / membership (any status): the
 *     read capability for that listing type is enough, so Staff and Read-only
 *     members can look too, and a suspended tenant can still check its pages;
 *   - a Circls reviewer, for anything in the approval queue (arenas included —
 *     they preview through their venue's page), gated like the queue itself.
 *
 * The response carries the consumer-site URL with the token already on it, so
 * neither portal needs to know where the consumer site lives.
 */

const partnerParams = z.object({
  tenantId: z.string().uuid(),
  type: z.enum(PREVIEW_TYPES),
  id: z.string().uuid(),
});

const adminParams = z.object({
  type: z.enum(LISTING_TYPES),
  id: z.string().uuid(),
});

const READ_CAP: Record<(typeof PREVIEW_TYPES)[number], Capability> = {
  venue: 'venues.read',
  event: 'events.read',
  membership: 'memberships.read',
};

export const listingPreviewRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /v1/tenants/:tenantId/listings/:type/:id/preview ─────────────────
  app.post(
    '/v1/tenants/:tenantId/listings/:type/:id/preview',
    { preHandler: requireAuth },
    async (req) => {
      const params = partnerParams.safeParse(req.params);
      if (!params.success) {
        throw new BadRequest('Invalid listing ref', 'bad_request', { issues: params.error.issues });
      }
      const { tenantId, type, id } = params.data;
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, READ_CAP[type]);
      const target = await resolvePreviewTarget(type, id);
      // Another organisation's listing reads as absent, not as forbidden:
      // ids must not be probeable across tenants.
      if (!target || target.tenantId !== tenantId) {
        throw new NotFound(`${type} not found`, 'listing_not_found');
      }
      return createListingPreview(target);
    },
  );

  // ── POST /v1/admin/listings/:type/:id/preview ──────────────────────────────
  app.post('/v1/admin/listings/:type/:id/preview', { preHandler: requireAuth }, async (req) => {
    const params = adminParams.safeParse(req.params);
    if (!params.success) {
      throw new BadRequest('Invalid listing ref', 'bad_request', { issues: params.error.issues });
    }
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.listings.review');
    const target = await resolvePreviewTarget(params.data.type, params.data.id);
    if (!target) throw new NotFound(`${params.data.type} not found`, 'listing_not_found');
    return createListingPreview(target);
  });
};
