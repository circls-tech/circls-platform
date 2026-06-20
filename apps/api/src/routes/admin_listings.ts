import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { BadRequest, NotFound } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireAuth } from '../middleware/require_auth.js';
import { currentUser } from '../middleware/current_user.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  approveListing,
  getListingDetail,
  LISTING_TYPES,
  listListingsForReview,
  rejectListing,
} from '../services/listing_service.js';

/**
 * Platform-admin listing approval. Partners create venues/arenas/memberships
 * in `pending_review` (events: draft → submit → pending_review); ops reviews
 * them here. All gated on `admin.listings.review`.
 */

const listQuerySchema = z.object({
  type: z.enum(LISTING_TYPES),
  status: z.string().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const paramsSchema = z.object({
  type: z.enum(LISTING_TYPES),
  id: z.string().uuid(),
});

const rejectBodySchema = z.object({ reason: z.string().min(1).max(500).optional() });

export const adminListingRoutes: FastifyPluginAsync = async (app) => {
  async function reviewCtx(req: FastifyRequest) {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.listings.review');
    return user;
  }

  // ── GET /v1/admin/listings?type=venue&status=pending_review ────────────────
  app.get('/v1/admin/listings', { preHandler: requireAuth }, async (req) => {
    await reviewCtx(req);
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid query parameters', 'bad_request', { issues: parsed.error.issues });
    }
    const rows = await listListingsForReview({
      type: parsed.data.type,
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
    });
    return { rows };
  });

  // ── GET /v1/admin/listings/:type/:id ──────────────────────────────────────
  app.get('/v1/admin/listings/:type/:id', { preHandler: requireAuth }, async (req) => {
    await reviewCtx(req);
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      throw new BadRequest('Invalid listing ref', 'bad_request', { issues: params.error.issues });
    }
    const detail = await getListingDetail(params.data.type, params.data.id);
    if (!detail) {
      throw new NotFound(`${params.data.type} not found`, 'listing_not_found');
    }
    return detail;
  });

  // ── POST /v1/admin/listings/:type/:id/approve ──────────────────────────────
  app.post('/v1/admin/listings/:type/:id/approve', { preHandler: requireAuth }, async (req) => {
    const user = await reviewCtx(req);
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      throw new BadRequest('Invalid listing ref', 'bad_request', { issues: params.error.issues });
    }
    return approveListing({ type: params.data.type, id: params.data.id, actorUserId: user.id });
  });

  // ── POST /v1/admin/listings/:type/:id/reject ───────────────────────────────
  app.post('/v1/admin/listings/:type/:id/reject', { preHandler: requireAuth }, async (req) => {
    const user = await reviewCtx(req);
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      throw new BadRequest('Invalid listing ref', 'bad_request', { issues: params.error.issues });
    }
    const body = rejectBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      throw new BadRequest('Invalid reject payload', 'bad_request', { issues: body.error.issues });
    }
    return rejectListing({
      type: params.data.type,
      id: params.data.id,
      actorUserId: user.id,
      ...(body.data.reason ? { reason: body.data.reason } : {}),
    });
  });
};
