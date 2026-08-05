import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { BadRequest, NotFound } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireAuth } from '../middleware/require_auth.js';
import { currentUser } from '../middleware/current_user.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  approveChangeRequest,
  getChangeRequestDetail,
  listChangeRequestsForReview,
  rejectChangeRequest,
} from '../services/event_change_requests_service.js';

/**
 * Platform-admin review of event change requests — a partner's proposed edits
 * to a PUBLISHED event's approval-gated fields (name/window/location/tiers).
 * Same review team and capability as listing approval
 * (`admin.listings.review`); approve applies the patch, reject records a
 * reason the partner sees.
 */

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const paramsSchema = z.object({ id: z.string().uuid() });

const rejectBodySchema = z.object({ reason: z.string().min(1).max(500).optional() });

export const adminChangeRequestRoutes: FastifyPluginAsync = async (app) => {
  async function reviewCtx(req: FastifyRequest) {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.listings.review');
    return user;
  }

  // ── GET /v1/admin/change-requests?limit= ───────────────────────────────────
  app.get('/v1/admin/change-requests', { preHandler: requireAuth }, async (req) => {
    await reviewCtx(req);
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid query parameters', 'bad_request', { issues: parsed.error.issues });
    }
    const rows = await listChangeRequestsForReview(
      parsed.data.limit ? { limit: parsed.data.limit } : undefined,
    );
    return { rows };
  });

  // ── GET /v1/admin/change-requests/:id ──────────────────────────────────────
  app.get('/v1/admin/change-requests/:id', { preHandler: requireAuth }, async (req) => {
    await reviewCtx(req);
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      throw new BadRequest('Invalid change request ref', 'bad_request', { issues: params.error.issues });
    }
    const detail = await getChangeRequestDetail(params.data.id);
    if (!detail) {
      throw new NotFound('Change request not found', 'change_request_not_found');
    }
    return detail;
  });

  // ── POST /v1/admin/change-requests/:id/approve ─────────────────────────────
  app.post('/v1/admin/change-requests/:id/approve', { preHandler: requireAuth }, async (req) => {
    const user = await reviewCtx(req);
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      throw new BadRequest('Invalid change request ref', 'bad_request', { issues: params.error.issues });
    }
    return approveChangeRequest({ id: params.data.id, actorUserId: user.id });
  });

  // ── POST /v1/admin/change-requests/:id/reject ──────────────────────────────
  app.post('/v1/admin/change-requests/:id/reject', { preHandler: requireAuth }, async (req) => {
    const user = await reviewCtx(req);
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      throw new BadRequest('Invalid change request ref', 'bad_request', { issues: params.error.issues });
    }
    const body = rejectBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      throw new BadRequest('Invalid reject payload', 'bad_request', { issues: body.error.issues });
    }
    return rejectChangeRequest({
      id: params.data.id,
      actorUserId: user.id,
      ...(body.data.reason ? { reason: body.data.reason } : {}),
    });
  });
};
