import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { type Tenant, type TenantSocials, tenantMembers, tenants } from '../db/schema/index.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { getStorage } from '../lib/storage.js';

export interface CreateTenantInput {
  name: string;
  slug: string;
}

/** Create a tenant and make the creator its owner, atomically. */
export async function createTenant(ownerUserId: string, input: CreateTenantInput): Promise<Tenant> {
  try {
    return await db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({
          name: input.name,
          slug: input.slug,
        })
        .returning();
      if (!tenant) throw new Error('tenant insert returned no row');
      await tx
        .insert(tenantMembers)
        .values({ userId: ownerUserId, tenantId: tenant.id, role: 'owner' });
      return tenant;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new Conflict('Slug already taken', 'slug_taken');
    throw err;
  }
}

/** Tenants the user is a member of. */
export async function listTenantsForUser(userId: string): Promise<Tenant[]> {
  const rows = await db
    .select({ tenant: tenants })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(eq(tenantMembers.userId, userId));
  return rows.map((r) => r.tenant);
}

/** Admin-only: every tenant on the platform. */
export async function listAllTenants(): Promise<Tenant[]> {
  return db.select().from(tenants);
}

/** Unscoped lookup — callers assert tenant membership on the result. */
export async function getTenantById(tenantId: string): Promise<Tenant | undefined> {
  return db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
}

// ── Org/brand profile (PR #107) ───────────────────────────────────────────────

/**
 * The org/brand profile as the partner editor sees it. Carries the editable
 * profile fields plus the derived logo URL. Billing/commission fields are
 * deliberately excluded — they live on the admin surfaces, not the org editor.
 */
export interface TenantProfileDTO {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  socials: TenantSocials | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  logoStorageKey: string | null;
  logoUrl: string | null;
  status: Tenant['status'];
}

function toTenantProfile(t: Tenant): TenantProfileDTO {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    description: t.description,
    contactEmail: t.contactEmail,
    contactPhone: t.contactPhone,
    websiteUrl: t.websiteUrl,
    socials: t.socials ?? null,
    addressLine1: t.addressLine1,
    addressLine2: t.addressLine2,
    city: t.city,
    state: t.state,
    postalCode: t.postalCode,
    country: t.country,
    logoStorageKey: t.logoStorageKey,
    logoUrl: t.logoStorageKey ? getStorage().publicUrl(t.logoStorageKey) : null,
    status: t.status,
  };
}

export async function getTenantProfile(tenantId: string): Promise<TenantProfileDTO> {
  const row = await getTenantById(tenantId);
  if (!row) throw new NotFound('Tenant not found', 'tenant_not_found');
  return toTenantProfile(row);
}

export interface UpdateTenantProfileInput {
  name?: string;
  description?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  websiteUrl?: string | null;
  socials?: TenantSocials | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export async function updateTenantProfile(
  tenantId: string,
  input: UpdateTenantProfileInput,
): Promise<TenantProfileDTO> {
  const set: Partial<typeof tenants.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.description !== undefined) set.description = input.description;
  if (input.contactEmail !== undefined) set.contactEmail = input.contactEmail;
  if (input.contactPhone !== undefined) set.contactPhone = input.contactPhone;
  if (input.websiteUrl !== undefined) set.websiteUrl = input.websiteUrl;
  if (input.socials !== undefined) set.socials = input.socials;
  if (input.addressLine1 !== undefined) set.addressLine1 = input.addressLine1;
  if (input.addressLine2 !== undefined) set.addressLine2 = input.addressLine2;
  if (input.city !== undefined) set.city = input.city;
  if (input.state !== undefined) set.state = input.state;
  if (input.postalCode !== undefined) set.postalCode = input.postalCode;
  if (input.country !== undefined) set.country = input.country;

  if (Object.keys(set).length === 0) return getTenantProfile(tenantId);
  const [row] = await db.update(tenants).set(set).where(eq(tenants.id, tenantId)).returning();
  if (!row) throw new NotFound('Tenant not found', 'tenant_not_found');
  return toTenantProfile(row);
}

// ── Public org/brand (PR #108) ────────────────────────────────────────────────

/**
 * Compact brand summary embedded in public venue/event/membership payloads so a
 * card can show "by {org}" without a second round-trip. Never carries
 * private/billing fields.
 */
export interface BrandSummary {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
}

export function toBrandSummary(b: {
  id: string;
  slug: string;
  name: string;
  logoStorageKey: string | null;
}): BrandSummary {
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    logoUrl: b.logoStorageKey ? getStorage().publicUrl(b.logoStorageKey) : null,
  };
}

/**
 * Public org profile returned by GET /v1/consumer/orgs/:slug. Exposes every
 * profile field EXCEPT internal/billing (commission_bps, subscription/internal
 * status, is_platform) — those never leave the server.
 */
export interface PublicOrg {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  websiteUrl: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  socials: TenantSocials | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  };
}

/** A single active org by slug, or null (inactive/missing → caller 404s). */
export async function getPublicOrgBySlug(slug: string): Promise<PublicOrg | null> {
  const row = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!row || row.status !== 'active' || row.isPlatform) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    logoUrl: row.logoStorageKey ? getStorage().publicUrl(row.logoStorageKey) : null,
    websiteUrl: row.websiteUrl,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    socials: row.socials ?? null,
    address: {
      line1: row.addressLine1,
      line2: row.addressLine2,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      country: row.country,
    },
  };
}

// ── Org logo (PR #107) ────────────────────────────────────────────────────────

/** Image content-types we accept, mapped to the stored key extension. */
const LOGO_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const MAX_LOGO_BYTES = 10 * 1024 * 1024; // 10 MiB

function logoPrefix(tenantId: string): string {
  return `tenants/${tenantId}/logo/`;
}

/** Step 1: presign a PUT the client uploads the logo straight to R2. */
export async function presignTenantLogo(tenantId: string, contentType: string) {
  const ext = LOGO_TYPES[contentType];
  if (!ext) {
    throw new Conflict(
      `Unsupported image type "${contentType}" (allowed: ${Object.keys(LOGO_TYPES).join(', ')})`,
      'unsupported_media_type',
    );
  }
  const { randomUUID } = await import('node:crypto');
  const key = `${logoPrefix(tenantId)}${randomUUID()}.${ext}`;
  return getStorage().presignUpload({ key, contentType });
}

/**
 * Step 2: confirm the upload. HEAD R2 for the real size/type, persist the key,
 * and delete the previously-set logo object (single-image semantics).
 */
export async function finalizeTenantLogo(
  tenantId: string,
  storageKey: string,
): Promise<TenantProfileDTO> {
  if (!storageKey.startsWith(logoPrefix(tenantId))) {
    throw new Conflict('storageKey does not belong to this tenant', 'bad_storage_key');
  }
  const storage = getStorage();
  const head = await storage.head(storageKey);
  if (!head) throw new Conflict('No uploaded object found for that storageKey', 'upload_not_found');
  if (!LOGO_TYPES[head.contentType]) {
    await storage.delete(storageKey);
    throw new Conflict(
      `Uploaded object is "${head.contentType}", not an allowed image type`,
      'unsupported_media_type',
    );
  }
  if (head.sizeBytes > MAX_LOGO_BYTES) {
    await storage.delete(storageKey);
    throw new Conflict(`Image is ${head.sizeBytes} bytes; max is ${MAX_LOGO_BYTES}`, 'image_too_large');
  }

  const existing = await getTenantById(tenantId);
  if (!existing) throw new NotFound('Tenant not found', 'tenant_not_found');

  const [row] = await db
    .update(tenants)
    .set({ logoStorageKey: storageKey })
    .where(eq(tenants.id, tenantId))
    .returning();
  if (!row) throw new NotFound('Tenant not found', 'tenant_not_found');

  // Best-effort GC of the replaced object (never block the response on it).
  if (existing.logoStorageKey && existing.logoStorageKey !== storageKey) {
    await storage.delete(existing.logoStorageKey).catch(() => {});
  }
  return toTenantProfile(row);
}

/** Remove the org logo (clears the column + deletes the object). */
export async function removeTenantLogo(tenantId: string): Promise<TenantProfileDTO> {
  const existing = await getTenantById(tenantId);
  if (!existing) throw new NotFound('Tenant not found', 'tenant_not_found');
  const [row] = await db
    .update(tenants)
    .set({ logoStorageKey: null })
    .where(eq(tenants.id, tenantId))
    .returning();
  if (!row) throw new NotFound('Tenant not found', 'tenant_not_found');
  if (existing.logoStorageKey) {
    await getStorage().delete(existing.logoStorageKey).catch(() => {});
  }
  return toTenantProfile(row);
}
