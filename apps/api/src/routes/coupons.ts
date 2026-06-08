import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../lib/errors.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import { assertCap } from '../middleware/require_cap.js';
import { requireAuth } from '../middleware/require_auth.js';
import { currentUser } from '../middleware/current_user.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import {
  createCoupon,
  deleteCoupon,
  listCoupons,
  updateCoupon,
  type CreateCouponInput,
  type UpdateCouponPatch,
} from '../services/coupon_service.js';

// ── Zod schemas ───────────────────────────────────────────────────────────────

const createBody = z.object({
  code: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  scopeType: z.enum(['org', 'venue', 'event', 'arena', 'membership']),
  scopeId: z.string().uuid().optional(),
  discountType: z.enum(['percent', 'fixed']),
  discountValue: z.number().int().positive(),
  maxDiscountPaise: z.number().int().positive().optional(),
  minOrderPaise: z.number().int().positive().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  maxRedemptions: z.number().int().positive().optional(),
  perUserLimit: z.number().int().positive().optional(),
});

const updateBody = z.object({
  description: z.string().max(500).nullable().optional(),
  minOrderPaise: z.number().int().positive().nullable().optional(),
  maxDiscountPaise: z.number().int().positive().nullable().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  perUserLimit: z.number().int().positive().nullable().optional(),
  status: z.enum(['active', 'paused', 'expired']).optional(),
});

type CreateBodyInput = z.infer<typeof createBody>;
type UpdateBodyInput = z.infer<typeof updateBody>;

function toCreateInput(b: CreateBodyInput): CreateCouponInput {
  const input: CreateCouponInput = {
    code: b.code,
    scopeType: b.scopeType,
    discountType: b.discountType,
    discountValue: b.discountValue,
    validFrom: b.validFrom ? new Date(b.validFrom) : null,
    validUntil: b.validUntil ? new Date(b.validUntil) : null,
  };
  if (b.description !== undefined) input.description = b.description;
  if (b.scopeId !== undefined) input.scopeId = b.scopeId;
  if (b.maxDiscountPaise !== undefined) input.maxDiscountPaise = b.maxDiscountPaise;
  if (b.minOrderPaise !== undefined) input.minOrderPaise = b.minOrderPaise;
  if (b.visibility !== undefined) input.visibility = b.visibility;
  if (b.maxRedemptions !== undefined) input.maxRedemptions = b.maxRedemptions;
  if (b.perUserLimit !== undefined) input.perUserLimit = b.perUserLimit;
  return input;
}

function toUpdatePatch(b: UpdateBodyInput): UpdateCouponPatch {
  const patch: UpdateCouponPatch = {};
  if (b.description !== undefined) patch.description = b.description;
  if (b.minOrderPaise !== undefined) patch.minOrderPaise = b.minOrderPaise;
  if (b.maxDiscountPaise !== undefined) patch.maxDiscountPaise = b.maxDiscountPaise;
  if (b.visibility !== undefined) patch.visibility = b.visibility;
  if (b.validFrom !== undefined)
    patch.validFrom = b.validFrom ? new Date(b.validFrom) : null;
  if (b.validUntil !== undefined)
    patch.validUntil = b.validUntil ? new Date(b.validUntil) : null;
  if (b.maxRedemptions !== undefined) patch.maxRedemptions = b.maxRedemptions;
  if (b.perUserLimit !== undefined) patch.perUserLimit = b.perUserLimit;
  if (b.status !== undefined) patch.status = b.status;
  return patch;
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export const couponRoutes: FastifyPluginAsync = async (app) => {
  // ── Org-scoped: /v1/tenants/:tenantId/coupons ─────────────────────────────

  app.get('/v1/tenants/:tenantId/coupons', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'discounts.read');
    return listCoupons({ kind: 'tenant', tenantId });
  });

  app.post('/v1/tenants/:tenantId/coupons', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'discounts.write');
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid coupon payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    return createCoupon(
      { tenantId, actorUserId: user.id },
      { kind: 'tenant', tenantId },
      toCreateInput(parsed.data),
    );
  });

  app.patch('/v1/tenants/:tenantId/coupons/:id', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'discounts.write');
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid coupon patch', 'bad_request', {
        issues: parsed.error.issues,
      });
    return updateCoupon(
      { tenantId, actorUserId: user.id },
      { kind: 'tenant', tenantId },
      id,
      toUpdatePatch(parsed.data),
    );
  });

  app.delete(
    '/v1/tenants/:tenantId/coupons/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenantId, id } = req.params as { tenantId: string; id: string };
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'discounts.write');
      await deleteCoupon({ tenantId, actorUserId: user.id }, { kind: 'tenant', tenantId }, id);
      return reply.status(204).send();
    },
  );

  // ── Admin-scoped: /v1/admin/coupons ──────────────────────────────────────

  app.get('/v1/admin/coupons', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.coupons.read');
    return listCoupons({ kind: 'platform' });
  });

  app.post('/v1/admin/coupons', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.coupons.write');
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid coupon payload', 'bad_request', {
        issues: parsed.error.issues,
      });
    return createCoupon(
      { tenantId: platformTenantId, actorUserId: user.id },
      { kind: 'platform' },
      toCreateInput(parsed.data),
    );
  });

  app.patch('/v1/admin/coupons/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.coupons.write');
    const parsed = updateBody.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid coupon patch', 'bad_request', {
        issues: parsed.error.issues,
      });
    return updateCoupon(
      { tenantId: platformTenantId, actorUserId: user.id },
      { kind: 'platform' },
      id,
      toUpdatePatch(parsed.data),
    );
  });

  app.delete('/v1/admin/coupons/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.coupons.write');
    await deleteCoupon(
      { tenantId: platformTenantId, actorUserId: user.id },
      { kind: 'platform' },
      id,
    );
    return reply.status(204).send();
  });
};
