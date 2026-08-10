import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { BadRequest } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireAuth } from '../middleware/require_auth.js';
import { currentUser } from '../middleware/current_user.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { executePayout, listPayouts, reconcileWeeklyPayouts } from '../services/payout_service.js';

/**
 * Platform-admin payouts. Circls is the merchant: the weekly worker computes
 * what's owed to each venue (gross − refunds − commission) and ops executes the
 * transfer out-of-band, marking it paid here. Read is gated on
 * `admin.payouts.read`; execution on `admin.payouts.execute`.
 */

const listQuerySchema = z.object({
  status: z.enum(['pending', 'paid']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const executeBodySchema = z.object({
  reference: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
});

const payoutIdParamSchema = z.object({ id: z.string().uuid() });

export const adminPayoutRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /v1/admin/payouts — paginated, newest first ────────────────────────
  app.get('/v1/admin/payouts', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.payouts.read');

    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid query parameters', 'bad_request', { issues: parsed.error.issues });
    }
    return listPayouts({
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
      ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
      ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
    });
  });

  // ── POST /v1/admin/payouts/reconcile — run reconciliation on demand ─────────
  // Same computation as the Monday 03:00 UTC worker (settles the most recently
  // completed Mon→Sun week). Idempotent: the unique (tenant, period) index makes
  // a re-run a no-op, so this is safe to hit any time — e.g. after a missed
  // worker run or a settlement backfill.
  app.post('/v1/admin/payouts/reconcile', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.payouts.execute');

    const inserted = await reconcileWeeklyPayouts();
    return { inserted };
  });

  // ── POST /v1/admin/payouts/:id/execute — mark a pending payout paid ─────────
  app.post('/v1/admin/payouts/:id/execute', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.payouts.execute');

    const params = payoutIdParamSchema.safeParse(req.params);
    if (!params.success) {
      throw new BadRequest('Invalid payout id', 'bad_request', { issues: params.error.issues });
    }
    const body = executeBodySchema.safeParse(req.body);
    if (!body.success) {
      throw new BadRequest('Invalid execute payload', 'bad_request', { issues: body.error.issues });
    }

    return executePayout({
      payoutId: params.data.id,
      actorUserId: user.id,
      reference: body.data.reference,
      note: body.data.note,
    });
  });
};
