/**
 * Circls super admins in partner orgs. A super admin (a Circls team member a
 * platform Owner switched on) may open any partner org in the partner portal
 * without joining it, to set it up for an org that asked for help. What they
 * may do there is SUPER_ADMIN_CAPS; requireTenantMembership grants it.
 *
 * Each visit is written to the org's audit log (at most once per
 * VISIT_LOG_WINDOW_HOURS per person), and so is every change they make, so
 * the org can see Circls was there.
 */
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLog } from '../db/schema/audit_log.js';
import { type Tenant, tenants } from '../db/schema/tenants.js';
import type { TenantRole } from '../db/schema/tenant_members.js';
import { writeAudit } from '../lib/audit.js';
import { NotFound } from '../lib/errors.js';

/** A portal reload or tab refocus within this window doesn't log another visit. */
export const VISIT_LOG_WINDOW_HOURS = 4;

const SEARCH_LIMIT = 20;

export interface SuperAdminOrgHit {
  id: string;
  name: string;
  slug: string;
  status: Tenant['status'];
  city: string | null;
}

/** Partner orgs whose name or slug contains `q` (all of them, by name, without one). */
export async function searchPartnerOrgs(q: string | undefined): Promise<SuperAdminOrgHit[]> {
  const term = q?.trim();
  const like = term ? `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      city: tenants.city,
    })
    .from(tenants)
    .where(
      and(
        eq(tenants.isPlatform, false),
        like ? or(ilike(tenants.name, like), ilike(tenants.slug, like)) : undefined,
      ),
    )
    .orderBy(asc(tenants.name))
    .limit(SEARCH_LIMIT);
}

/** The org as the portal's org list carries it: a /v1/me/tenants row, marked as a visit. */
export type SuperAdminVisitRow = Tenant & {
  myRole: TenantRole;
  mySuperAdmin: false;
  superAdminVisit: true;
};

/**
 * Open a partner org as a super admin (the caller has checked they are one):
 * logs the visit on the org's audit log unless this person's last one is
 * recent, and returns the row the portal adds to its org list.
 */
export async function visitPartnerOrg(userId: string, tenantId: string): Promise<SuperAdminVisitRow> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant || tenant.isPlatform) throw new NotFound('Organisation not found', 'tenant_not_found');

  const [recent] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantId),
        eq(auditLog.actorUserId, userId),
        eq(auditLog.action, 'tenant.super_admin_visited'),
        sql`${auditLog.createdAt} > now() - make_interval(hours => ${VISIT_LOG_WINDOW_HOURS}::int)`,
      ),
    )
    .limit(1);
  if (!recent) {
    await writeAudit(
      db,
      { tenantId, actorUserId: userId },
      'tenant.super_admin_visited',
      'tenant',
      tenantId,
      null,
      null,
    );
  }

  // Their caps are SUPER_ADMIN_CAPS (a Manager's without team or API keys);
  // the portal reads that from superAdminVisit, `myRole` only names the level.
  return { ...tenant, myRole: 'manager', mySuperAdmin: false, superAdminVisit: true };
}
