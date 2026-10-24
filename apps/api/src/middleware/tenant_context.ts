import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type TenantMember, tenantMembers } from '../db/schema/index.js';
import { tenants } from '../db/schema/tenants.js';
import { isSuspendedTenant } from '../lib/authz/can.js';
import { isSuperAdmin } from '../lib/authz/super_admin.js';
import { noteSuperAdminAccess } from '../lib/request_audit_context.js';
import { Forbidden } from '../lib/errors.js';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: TenantMember['role'];
  /** True only for the Circls platform tenant. Drives the authz map choice. */
  isPlatform: boolean;
  /** Circls suspended this (partner) tenant: its members can look, not change. */
  suspended: boolean;
  /**
   * A Circls super admin who is not a member here: `role` reads 'manager' (so
   * role comparisons treat them like one) but `can` grants SUPER_ADMIN_CAPS.
   */
  superAdmin: boolean;
  /** Terms & Conditions acceptance state — read by assertTermsAccepted. */
  termsVersion: string | null;
  termsAcceptedAt: Date | null;
}

/**
 * The app-layer tenancy guard. Asserts the user is a member of the tenant,
 * fetches the tenant's `is_platform` flag, and returns the scoped context.
 * Every tenant-scoped service takes a resolved tenantId and filters by it
 * explicitly — a missing membership is a 403, never a cross-tenant leak.
 *
 * The one exception: a Circls super admin may act in any partner tenant
 * without a membership (never in the Circls tenant itself, where they are
 * members anyway). Their own membership, where they have one, wins.
 */
export async function requireTenantMembership(
  userId: string,
  tenantId: string,
): Promise<TenantContext> {
  const [row] = await db
    .select({
      role: tenantMembers.role,
      isPlatform: tenants.isPlatform,
      status: tenants.status,
      termsVersion: tenants.termsVersion,
      termsAcceptedAt: tenants.termsAcceptedAt,
    })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .where(and(eq(tenantMembers.userId, userId), eq(tenantMembers.tenantId, tenantId)))
    .limit(1);
  if (row) {
    return {
      tenantId,
      userId,
      role: row.role,
      isPlatform: row.isPlatform,
      suspended: isSuspendedTenant(row),
      superAdmin: false,
      termsVersion: row.termsVersion,
      termsAcceptedAt: row.termsAcceptedAt,
    };
  }
  const visit = await superAdminContext(userId, tenantId);
  if (!visit) throw new Forbidden('Not a member of this tenant', 'tenant_forbidden');
  return visit;
}

/** The context a super admin gets in a partner tenant they don't belong to, or null. */
async function superAdminContext(userId: string, tenantId: string): Promise<TenantContext | null> {
  if (!(await isSuperAdmin(userId))) return null;
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { isPlatform: true, status: true, termsVersion: true, termsAcceptedAt: true },
  });
  if (!tenant || tenant.isPlatform) return null;
  // So whatever this request changes shows in the org's Activity Log.
  noteSuperAdminAccess(userId, tenantId);
  return {
    tenantId,
    userId,
    role: 'manager',
    isPlatform: false,
    suspended: isSuspendedTenant(tenant),
    superAdmin: true,
    termsVersion: tenant.termsVersion,
    termsAcceptedAt: tenant.termsAcceptedAt,
  };
}
