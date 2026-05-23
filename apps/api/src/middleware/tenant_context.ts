import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type TenantMember, tenantMembers } from '../db/schema/index.js';
import { Forbidden } from '../lib/errors.js';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: TenantMember['role'];
}

/**
 * The app-layer tenancy guard. Asserts the user is a member of the tenant and
 * returns the scoped context. Every tenant-scoped service takes a resolved
 * tenantId and filters by it explicitly, so a missing membership is a 403 —
 * never a cross-tenant data leak.
 */
export async function requireTenantMembership(
  userId: string,
  tenantId: string,
): Promise<TenantContext> {
  const member = await db.query.tenantMembers.findFirst({
    where: and(eq(tenantMembers.userId, userId), eq(tenantMembers.tenantId, tenantId)),
  });
  if (!member) throw new Forbidden('Not a member of this tenant', 'tenant_forbidden');
  return { tenantId, userId, role: member.role };
}
