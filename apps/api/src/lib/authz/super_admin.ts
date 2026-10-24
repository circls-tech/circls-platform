import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { tenantMembers } from '../../db/schema/tenant_members.js';
import { tenants } from '../../db/schema/tenants.js';
import { users } from '../../db/schema/users.js';
import { Forbidden } from '../errors.js';

/**
 * Whether the user is a Circls super admin: on the Circls team, with the
 * switch a platform Owner turns on. Leaving the team ends it (the row goes).
 */
export async function isSuperAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: tenantMembers.userId })
    .from(tenantMembers)
    .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
    .innerJoin(users, eq(users.id, tenantMembers.userId))
    .where(
      and(
        eq(tenantMembers.userId, userId),
        eq(tenantMembers.superAdmin, true),
        eq(tenants.isPlatform, true),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function assertSuperAdmin(userId: string): Promise<void> {
  if (!(await isSuperAdmin(userId))) {
    throw new Forbidden('Only Circls super admins can do this', 'super_admin_required');
  }
}
