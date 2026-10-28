/**
 * Circls super admins in partner orgs. A super admin (a Circls team member a
 * platform Owner switched on) may open a partner org in the partner portal
 * without joining it — but only while the org has let Circls in ("Get help
 * from Circls", circls_support_service). What they may do there is
 * SUPER_ADMIN_CAPS; requireTenantMembership grants it.
 *
 * Their first visit in each grant is written to the org's audit log, and so
 * is every change they make, so the org can see who from Circls was there.
 */
import { and, desc, eq, gt, ilike, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLog } from '../db/schema/audit_log.js';
import { circlsSupportGrants } from '../db/schema/circls_support_grants.js';
import { type Tenant, tenants } from '../db/schema/tenants.js';
import type { TenantRole } from '../db/schema/tenant_members.js';
import { writeAudit } from '../lib/audit.js';
import { Forbidden, NotFound } from '../lib/errors.js';
import { liveGrant } from './circls_support_service.js';

const SEARCH_LIMIT = 50;

export interface SuperAdminOrgHit {
  id: string;
  name: string;
  slug: string;
  status: Tenant['status'];
  city: string | null;
  /** When Circls's access to it ends. */
  expiresAt: string;
  /** What the org asked for help with, if it said. */
  note: string | null;
}

/**
 * Partner orgs that have Circls let in right now, most recent request first;
 * with `q`, only those whose name or slug contains it.
 */
export async function listOrgsAskingForHelp(q: string | undefined): Promise<SuperAdminOrgHit[]> {
  const term = q?.trim();
  const like = term ? `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      city: tenants.city,
      expiresAt: circlsSupportGrants.expiresAt,
      note: circlsSupportGrants.note,
    })
    .from(circlsSupportGrants)
    .innerJoin(tenants, eq(tenants.id, circlsSupportGrants.tenantId))
    .where(
      and(
        isNull(circlsSupportGrants.endedAt),
        gt(circlsSupportGrants.expiresAt, sql`now()`),
        eq(tenants.isPlatform, false),
        like ? or(ilike(tenants.name, like), ilike(tenants.slug, like)) : undefined,
      ),
    )
    .orderBy(desc(circlsSupportGrants.createdAt))
    .limit(SEARCH_LIMIT);
  return rows.map((r) => ({ ...r, expiresAt: r.expiresAt.toISOString() }));
}

/** The org as the portal's org list carries it: a /v1/me/tenants row, marked as a visit. */
export type SuperAdminVisitRow = Tenant & {
  myRole: TenantRole;
  mySuperAdmin: false;
  superAdminVisit: true;
  /** When Circls's access ends (the org can also end it sooner). */
  circlsSupportUntil: string;
};

/**
 * Open a partner org as a super admin (the caller has checked they are one).
 * Refused unless the org has Circls let in. Logs the visit on the org's
 * audit log the first time this person opens it during the grant, and
 * returns the row the portal adds to its org list.
 */
export async function visitPartnerOrg(userId: string, tenantId: string): Promise<SuperAdminVisitRow> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant || tenant.isPlatform) throw new NotFound('Organisation not found', 'tenant_not_found');
  const grant = await liveGrant(tenantId);
  if (!grant) {
    throw new Forbidden(
      'This organisation hasn’t let Circls in — they can from “Get help from Circls” in their portal',
      'circls_support_not_granted',
    );
  }

  const [already] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenantId, tenantId),
        eq(auditLog.actorUserId, userId),
        eq(auditLog.action, 'tenant.super_admin_visited'),
        sql`${auditLog.createdAt} >= ${grant.createdAt.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  if (!already) {
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

  // Their caps are SUPER_ADMIN_CAPS; the portal reads that from
  // superAdminVisit, `myRole` only names the level.
  return {
    ...tenant,
    myRole: 'manager',
    mySuperAdmin: false,
    superAdminVisit: true,
    circlsSupportUntil: grant.expiresAt.toISOString(),
  };
}
