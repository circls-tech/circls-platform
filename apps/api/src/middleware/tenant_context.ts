import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type TenantMember, tenantMembers } from '../db/schema/index.js';
import { tenants } from '../db/schema/tenants.js';
import { Forbidden } from '../lib/errors.js';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: TenantMember['role'];
  /** True only for the Circls platform tenant. Drives the authz map choice. */
  isPlatform: boolean;
}

/**
 * The app-layer tenancy guard. Asserts the user is a member of the tenant,
 * fetches the tenant's `is_platform` flag, and returns the scoped context.
 * Every tenant-scoped service takes a resolved tenantId and filters by it
 * explicitly — a missing membership is a 403, never a cross-tenant leak.
 */
export async function requireTenantMembership(
  userId: string,
  tenantId: string,
): Promise<TenantContext> {
  const [row] = await db
    .select({
      role: tenantMembers.role,
      isPlatform: tenants.isPlatform,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(and(eq(tenantMembers.userId, userId), eq(tenantMembers.tenantId, tenantId)))
    .limit(1);
  if (!row) throw new Forbidden('Not a member of this tenant', 'tenant_forbidden');
  return { tenantId, userId, role: row.role, isPlatform: row.isPlatform };
}
