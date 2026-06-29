import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';
import type { TenantSocials } from '../db/schema/index.js';
import { BadRequest } from '../lib/errors.js';
import { assertCap } from '../middleware/require_cap.js';
import { currentUser } from '../middleware/current_user.js';
import { requireAuth } from '../middleware/require_auth.js';
import { requireTenantMembership } from '../middleware/tenant_context.js';
import { getAnalytics } from '../services/analytics_service.js';
import { listAuditLog } from '../services/audit_log_service.js';
import {
  createTenant,
  finalizeTenantLogo,
  getTenantProfile,
  listAllTenants,
  listTenantsForUser,
  presignTenantLogo,
  removeTenantLogo,
  updateTenantProfile,
  type UpdateTenantProfileInput,
} from '../services/tenant_service.js';

const createTenantSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with dashes'),
});

// ── Org/brand profile (PR #107) ───────────────────────────────────────────────
// Empty strings from form inputs collapse to null so we never persist "".
const nullableTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s.length === 0 ? null : s))
    .nullable()
    .optional();

const socialsSchema = z
  .object({
    instagram: z.string().trim().max(200).optional(),
    facebook: z.string().trim().max(200).optional(),
    x: z.string().trim().max(200).optional(),
    youtube: z.string().trim().max(200).optional(),
  })
  .nullable()
  .optional()
  // Drop undefined/empty values so the persisted blob only carries set handles
  // (satisfies exactOptionalPropertyTypes on TenantSocials).
  .transform((v): TenantSocials | null | undefined => {
    if (v == null) return v;
    const out: TenantSocials = {};
    if (v.instagram) out.instagram = v.instagram;
    if (v.facebook) out.facebook = v.facebook;
    if (v.x) out.x = v.x;
    if (v.youtube) out.youtube = v.youtube;
    return out;
  });

const updateTenantProfileSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: nullableTrimmed(1000),
  contactEmail: z
    .union([z.string().trim().email().max(200), z.literal('')])
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
  contactPhone: nullableTrimmed(40),
  websiteUrl: z
    .union([z.string().trim().url().max(300), z.literal('')])
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
  socials: socialsSchema,
  addressLine1: nullableTrimmed(200),
  addressLine2: nullableTrimmed(200),
  city: nullableTrimmed(120),
  state: nullableTrimmed(120),
  postalCode: nullableTrimmed(20),
  country: nullableTrimmed(120),
});

const logoPresignSchema = z.object({ contentType: z.string().min(1).max(100) });
const logoFinalizeSchema = z.object({ storageKey: z.string().min(1).max(512) });

export const tenantRoutes: FastifyPluginAsync = async (app) => {
  // Partner: create a tenant (creator becomes owner).
  app.post('/v1/tenants', { preHandler: requireAuth }, async (req) => {
    const parsed = createTenantSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid tenant payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const { name, slug } = parsed.data;
    return createTenant(user.id, { name, slug });
  });

  // Partner: tenants the caller belongs to.
  app.get('/v1/me/tenants', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    return listTenantsForUser(user.id);
  });

  // Admin: every tenant on the platform.
  app.get('/v1/tenants', { preHandler: requireAuth }, async (req) => {
    const user = await currentUser(req);
    const platformTenantId = await getPlatformTenantId();
    const ctx = await requireTenantMembership(user.id, platformTenantId);
    assertCap(ctx, 'admin.tenants.read');
    return listAllTenants();
  });

  // ── Org/brand profile (PR #107) ─────────────────────────────────────────────

  // Partner: load the org/brand profile (any member can read).
  app.get('/v1/tenants/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, id);
    assertCap(ctx, 'tenant.read');
    return getTenantProfile(id);
  });

  // Partner: edit the org/brand profile (owner/manager only — tenant.update).
  app.patch('/v1/tenants/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = updateTenantProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid org profile payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, id);
    assertCap(ctx, 'tenant.update');
    // Forward only provided keys (exactOptional UpdateTenantProfileInput).
    const p = parsed.data;
    const input: UpdateTenantProfileInput = {
      ...(p.name !== undefined && { name: p.name }),
      ...(p.description !== undefined && { description: p.description }),
      ...(p.contactEmail !== undefined && { contactEmail: p.contactEmail }),
      ...(p.contactPhone !== undefined && { contactPhone: p.contactPhone }),
      ...(p.websiteUrl !== undefined && { websiteUrl: p.websiteUrl }),
      ...(p.socials !== undefined && { socials: p.socials }),
      ...(p.addressLine1 !== undefined && { addressLine1: p.addressLine1 }),
      ...(p.addressLine2 !== undefined && { addressLine2: p.addressLine2 }),
      ...(p.city !== undefined && { city: p.city }),
      ...(p.state !== undefined && { state: p.state }),
      ...(p.postalCode !== undefined && { postalCode: p.postalCode }),
      ...(p.country !== undefined && { country: p.country }),
    };
    return updateTenantProfile(id, input);
  });

  // Partner: org logo upload (presign → PUT → finalize), owner/manager only.
  app.post('/v1/tenants/:id/logo/upload-presign', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = logoPresignSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid presign payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, id);
    assertCap(ctx, 'tenant.update');
    return presignTenantLogo(id, parsed.data.contentType);
  });

  app.post('/v1/tenants/:id/logo', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const parsed = logoFinalizeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequest('Invalid finalize payload', 'bad_request', { issues: parsed.error.issues });
    }
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, id);
    assertCap(ctx, 'tenant.update');
    return finalizeTenantLogo(id, parsed.data.storageKey);
  });

  app.delete('/v1/tenants/:id/logo', { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const user = await currentUser(req);
    const ctx = await requireTenantMembership(user.id, id);
    assertCap(ctx, 'tenant.update');
    return removeTenantLogo(id);
  });

  // Partner: tenant-scoped, slot-based analytics (today + trailing 7 days, IST).
  app.get('/v1/tenants/:tenantId/analytics', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);
    return getAnalytics(tenantId);
  });

  // Partner: paged, filterable audit log for a tenant.
  const auditLogQuerySchema = z.object({
    from:       z.string().datetime({ offset: true }).optional(),
    to:         z.string().datetime({ offset: true }).optional(),
    action:     z.string().optional(),
    entityType: z.string().optional(),
    cursor:     z.string().optional(),
    limit:      z.coerce.number().int().min(1).max(100).optional(),
  });

  app.get('/v1/tenants/:tenantId/audit-log', { preHandler: requireAuth }, async (req) => {
    const { tenantId } = req.params as { tenantId: string };
    const user = await currentUser(req);
    await requireTenantMembership(user.id, tenantId);

    const parsed = auditLogQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new BadRequest('Invalid query parameters', 'bad_request', { issues: parsed.error.issues });
    }

    const { from, to, action, entityType, cursor, limit } = parsed.data;
    return listAuditLog(tenantId, {
      ...(from       !== undefined && { from }),
      ...(to         !== undefined && { to }),
      ...(action     !== undefined && { action }),
      ...(entityType !== undefined && { entityType }),
      ...(cursor     !== undefined && { cursor }),
      ...(limit      !== undefined && { limit }),
    });
  });
};
