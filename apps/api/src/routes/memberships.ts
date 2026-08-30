import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { assertTermsAccepted } from '../middleware/require_terms.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { benefitsSchema, coerceBenefits } from '../lib/membership_benefits.js';
import {
  qrTicketConfigSchema,
  toQrTicketConfig,
  toTierQrTicketConfig,
} from '../lib/qr_ticket_config_schema.js';
import {
  addExternalMember,
  createMembership,
  refundMember,
  finalizeMembershipCover,
  getMembership,
  listMembershipPurchases,
  listMembershipsForTenant,
  listUserMemberships,
  presignMembershipCover,
  purchaseMembership,
  removeMembershipCover,
  setMembershipActive,
  updateMember,
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
  // Per-tier QR override: omitted/null = inherit the plan's config;
  // enabled:false = explicitly off for this tier; enabled:true = custom rules.
  qrTicketConfig: qrTicketConfigSchema.optional(),
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
    qrTicketConfig: t.qrTicketConfig !== undefined ? toTierQrTicketConfig(t.qrTicketConfig) : null,
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
    qrTicketConfig: qrTicketConfigSchema.optional(),
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
  qrTicketConfig: qrTicketConfigSchema.optional(),
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
    assertTermsAccepted(ctx);
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
      ...(parsed.data.qrTicketConfig !== undefined
        ? { qrTicketConfig: toQrTicketConfig(parsed.data.qrTicketConfig) }
        : {}),
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
    if (parsed.data.qrTicketConfig !== undefined)
      patch.qrTicketConfig = toQrTicketConfig(parsed.data.qrTicketConfig);
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

  /**
   * A member the partner signed up off-platform. Counts towards tier capacity
   * like any purchase; writes no payment, so it never reaches a payout.
   */
  const addMemberSchema = z.object({
    name: z.string().min(1).max(200),
    contact: z.string().max(200).optional(),
    membershipTierId: z.string().uuid().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
  });

  app.post(
    '/v1/tenants/:tenantId/memberships/:id/members',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { tenantId, id } = req.params as { tenantId: string; id: string };
      const user = await currentUser(req);
      const memberCtx = await requireTenantMembership(user.id, tenantId);
      assertTermsAccepted(memberCtx);
      const parsed = addMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid member', 'bad_request', { issues: parsed.error.issues });
      }
      const result = await addExternalMember(
        { tenantId, actorUserId: user.id },
        {
          membershipId: id,
          name: parsed.data.name,
          ...(parsed.data.contact ? { contact: parsed.data.contact } : {}),
          ...(parsed.data.membershipTierId
            ? { membershipTierId: parsed.data.membershipTierId }
            : {}),
          ...(parsed.data.startsAt ? { startsAt: new Date(parsed.data.startsAt) } : {}),
          ...(parsed.data.endsAt ? { endsAt: new Date(parsed.data.endsAt) } : {}),
        },
      );
      return reply.code(201).send(result);
    },
  );

  /**
   * Refund a member's purchase and end their membership. Distinct from the
   * cancel above, which only frees the seat and moves no money.
   */
  const refundMemberSchema = z.object({ reason: z.string().min(1).max(500) });

  app.post(
    '/v1/tenants/:tenantId/memberships/:membershipId/members/:userMembershipId/refund',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, membershipId, userMembershipId } = req.params as {
        tenantId: string;
        membershipId: string;
        userMembershipId: string;
      };
      const user = await currentUser(req);
      const memberCtx = await requireTenantMembership(user.id, tenantId);
      assertTermsAccepted(memberCtx);
      const parsed = refundMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('A reason is required', 'bad_request', {
          issues: parsed.error.issues,
        });
      }
      return refundMember(
        { tenantId, actorUserId: user.id },
        userMembershipId,
        membershipId,
        parsed.data.reason,
      );
    },
  );

  /** Correct a member's validity window, or cancel their membership. */
  const updateMemberSchema = z
    .object({
      startsAt: z.string().datetime().optional(),
      endsAt: z.string().datetime().optional(),
      status: z.enum(['active', 'cancelled']).optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: 'Nothing to update' });

  // Nested under the plan on purpose: /v1/tenants/:tenantId/members/:userId is
  // already taken by team-member role edits, and fastify matches on path shape
  // rather than param name, so a flat path here collides and the server refuses
  // to boot.
  app.patch(
    '/v1/tenants/:tenantId/memberships/:membershipId/members/:userMembershipId',
    { preHandler: requireAuth },
    async (req) => {
      const { tenantId, membershipId, userMembershipId } = req.params as {
        tenantId: string;
        membershipId: string;
        userMembershipId: string;
      };
      const user = await currentUser(req);
      const memberCtx = await requireTenantMembership(user.id, tenantId);
      assertTermsAccepted(memberCtx);
      const parsed = updateMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequest('Invalid update', 'bad_request', { issues: parsed.error.issues });
      }
      await updateMember({ tenantId, actorUserId: user.id }, userMembershipId, membershipId, {
        ...(parsed.data.startsAt ? { startsAt: new Date(parsed.data.startsAt) } : {}),
        ...(parsed.data.endsAt ? { endsAt: new Date(parsed.data.endsAt) } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
      });
      return { ok: true };
    },
  );

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
