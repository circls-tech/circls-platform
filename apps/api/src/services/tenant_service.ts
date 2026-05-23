import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { type Tenant, tenantMembers, tenants } from '../db/schema/index.js';
import { Conflict } from '../lib/errors.js';

export interface CreateTenantInput {
  name: string;
  slug: string;
  legalEntityName?: string | null;
  gstin?: string | null;
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
          legalEntityName: input.legalEntityName ?? null,
          gstin: input.gstin ?? null,
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
