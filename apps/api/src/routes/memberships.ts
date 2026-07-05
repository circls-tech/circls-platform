import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { benefitsSchema, coerceBenefits } from '../lib/membership_benefits.js';
import {
  createMembership,
  finalizeMembershipCover,
  getMembership,
  listMembershipPurchases,
  listMembershipsForTenant,
  listUserMemberships,
  presignMembershipCover,
  purchaseMembership,
  removeMembershipCover,
  setMembershipActive,
  updateMembership,
} from '../services/memberships_service.js';

const termsField = z
  .string()
  .trim()
  .max(5000)
  .transform((s) => (s.length === 0 ? null : s))
  .nullable()
  .optional();

const tierSchema = z.object({
  name: z.string().min(1).max(200),
  description: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => v ?? null),
  pricePaise: z.number().int().min(0),
  durationDays: z.number().int().min(1).max(3650),
  benefits: benefitsSchema.optional(),
  capacity: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});
const tiersField = z.array(tierSchema).min(1).max(20);

/** Map a parsed tier to the service input, coercing its benefits to the typed shape. */
function tierToInput(t: z.infer<typeof tierSchema>) {
  return {
    name: t.name,
    description: t.description,
    pricePaise: t.pricePaise,
    durationDays: t.durationDays,
    benefits: t.benefits !== undefined ? coerceBenefits(t.benefits) : { items: [] },
    capacity: t.capacity,
  };
}

const createSchema = z
  .object({
    venueId: z.string().uuid().optional(),
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    terms: termsField,
    // Legacy single-plan fields (still accepted). A `tiers` array supersedes them;
    // when only these are sent the service synthesizes a single "Standard" tier.
    pricePaise: z.number().int().min(0).optional(),
    durationDays: z.number().int().min(1).max(3650).optional(),
    benefits: benefitsSchema.optional(),
    tiers: tiersField.optional(),
  })
  .refine(
    (d) => (d.tiers && d.tiers.length > 0) || (d.pricePaise !== undefined && d.durationDays !== undefined),
    { message: 'Provide tiers, or pricePaise + durationDays' },
  );

const updateSchema = z.object({
  venueId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  terms: termsField,
  // Legacy membership-level fields stay editable; `tiers` replaces all tiers.
  pricePaise: z.number().int().min(0).optional(),
  durationDays: z.number().int().min(1).max(3650).optional(),
  benefits: benefitsSchema.optional(),
  tiers: tiersField.optional(),
});

const purchaseSchema = z.object({
  membershipTierId: z.string().uuid().optional(),
});

const coverPresignSchema = z.object({ contentType: z.string().min(1).max(100) });
const coverFinalizeSchema = z.object({ storageKey: z.string().min(1).max(512) });

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
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'memberships.write');
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
      terms: parsed.data.terms,
      ...(parsed.data.tiers ? { tiers: parsed.data.tiers.map(tierToInput) } : {}),
      ...(parsed.data.pricePaise !== undefined ? { pricePaise: parsed.data.pricePaise } : {}),
      ...(parsed.data.durationDays !== undefined ? { durationDays: parsed.data.durationDays } : {}),
      ...(parsed.data.benefits !== undefined ? { benefits: coerceBenefits(parsed.data.benefits) } : {}),
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
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'memberships.write');
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid membership patch', 'bad_request', { issues: parsed.error.issues });
    const patch: Parameters<typeof updateMembership>[2] = {};
    if (parsed.data.venueId !== undefined) patch.venueId = parsed.data.venueId;
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;
    if (parsed.data.terms !== undefined) patch.terms = parsed.data.terms;
    if (parsed.data.pricePaise !== undefined) patch.pricePaise = parsed.data.pricePaise;
    if (parsed.data.durationDays !== undefined) patch.durationDays = parsed.data.durationDays;
    if (parsed.data.benefits !== undefined) patch.benefits = coerceBenefits(parsed.data.benefits);
    if (parsed.data.tiers !== undefined) patch.tiers = parsed.data.tiers.map(tierToInput);
    return updateMembership({ tenantId, actorUserId: user.id }, id, patch);
  });

  // ── Artwork (PR #110): single cover image, presign → PUT → finalize. ─────────
  app.post(
    '/v1/tenants/:tenantId/memberships/:id/cover/upload-presign',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, id } = req.params as { tenantId: string; id: string };
      const parsed = coverPresignSchema.safeParse(req.body);
      if (!parsed.success)
        throw new BadRequest('Invalid presign payload', 'bad_request', { issues: parsed.error.issues });
      const user = await currentUser(req);
      const ctx = await requireTenantMembership(user.id, tenantId);
      assertCap(ctx, 'memberships.write');
      return presignMembershipCover(tenantId, id, parsed.data.contentType);
    },
  );

  app.post('/v1/tenants/:tenantId/memberships/:id/cover', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const parsed = coverFinalizeSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequest('Invalid finalize payload', 'bad_request', { issues: parsed.error.issues });
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'memberships.write');
    return finalizeMembershipCover(tenantId, id, parsed.data.storageKey);
  });

  app.delete('/v1/tenants/:tenantId/memberships/:id/cover', { preHandler: requireAuth }, async (req) => {
    const { tenantId, id } = req.params as { tenantId: string; id: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, tenantId);
    assertCap(ctx, 'memberships.write');
    return removeMembershipCover(tenantId, id);
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
    const parsed = purchaseSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      throw new BadRequest('Invalid purchase payload', 'bad_request', { issues: parsed.error.issues });
    return purchaseMembership({
      membershipId: id,
      userId: user.id,
      membershipTierId: parsed.data.membershipTierId,
    });
  });

  // Current user's active memberships (across tenants).
  app.get('/v1/users/me/memberships', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return listUserMemberships(user.id);
  });
};
