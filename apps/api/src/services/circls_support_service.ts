/**
 * "Get help from Circls": a partner org lets Circls into its portal for
 * GRANT_HOURS. While the grant is live any Circls super admin may open the
 * org (requireTenantMembership), as a Manager would bar SUPER_ADMIN_WITHHELD.
 * Owners and Managers ask for it (members.invite) and can end it early from
 * the Team page (members.remove); otherwise it simply runs out. Asking again
 * while one is live restarts the clock. Each step lands in the org's audit
 * log, and a new request emails the Circls admin team.
 */
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type CirclsSupportGrant, circlsSupportGrants } from '../db/schema/circls_support_grants.js';
import { users } from '../db/schema/users.js';
import { writeAudit } from '../lib/audit.js';
import { NotFound } from '../lib/errors.js';
import { onCirclsSupportRequested } from './notification_hooks.js';

export const GRANT_HOURS = 3;
const GRANT_MS = GRANT_HOURS * 60 * 60 * 1000;

type Exec = Pick<typeof db, 'select'>;

/** Live: not ended, and not yet run out. */
function live(tenantId: string) {
  return and(
    eq(circlsSupportGrants.tenantId, tenantId),
    isNull(circlsSupportGrants.endedAt),
    gt(circlsSupportGrants.expiresAt, sql`now()`),
  );
}

/** The org's live grant, if Circls is let in right now. */
export async function liveGrant(tenantId: string, exec: Exec = db): Promise<CirclsSupportGrant | null> {
  const [row] = await exec
    .select()
    .from(circlsSupportGrants)
    .where(live(tenantId))
    .orderBy(desc(circlsSupportGrants.createdAt))
    .limit(1);
  return row ?? null;
}

export interface CirclsSupportStatus {
  /** Null when Circls isn't let in. */
  active: {
    grantId: string;
    expiresAt: string;
    startedAt: string;
    note: string | null;
    requestedByName: string | null;
    /** The Circls super admins who have opened the org during this grant. */
    helpers: { userId: string; name: string | null }[];
  } | null;
}

/** For the Team page: is Circls let in, until when, and who has come in. */
export async function circlsSupportStatus(tenantId: string): Promise<CirclsSupportStatus> {
  const grant = await liveGrant(tenantId);
  if (!grant) return { active: null };
  const [requester] = await db
    .select({ name: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, grant.requestedByUserId))
    .limit(1);
  const helpers = (await db.execute<{ user_id: string; name: string | null }>(sql`
    SELECT DISTINCT ON (al.actor_user_id) al.actor_user_id AS user_id, u.display_name AS name
      FROM audit_log al
      JOIN users u ON u.id = al.actor_user_id
     WHERE al.tenant_id = ${tenantId}::uuid
       AND al.action = 'tenant.super_admin_visited'
       AND al.created_at >= ${grant.createdAt.toISOString()}::timestamptz
     ORDER BY al.actor_user_id, al.created_at
  `)) as unknown as { user_id: string; name: string | null }[];
  return {
    active: {
      grantId: grant.id,
      expiresAt: grant.expiresAt.toISOString(),
      startedAt: grant.createdAt.toISOString(),
      note: grant.note,
      requestedByName: requester?.name ?? requester?.email ?? null,
      helpers: helpers.map((h) => ({ userId: h.user_id, name: h.name })),
    },
  };
}

/**
 * Let Circls in for GRANT_HOURS from now: a new grant, or — when one is live —
 * the same grant with its clock restarted (and the note replaced, if a new
 * one is given). Only a new grant emails the Circls team.
 */
export async function grantCirclsSupport(input: {
  tenantId: string;
  userId: string;
  note: string | null;
}): Promise<CirclsSupportStatus> {
  const expiresAt = new Date(Date.now() + GRANT_MS);
  const created = await db.transaction(async (tx) => {
    // Serialise requests for one org, so two clicks can't make two grants.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`circls_support:${input.tenantId}`}))`);
    const current = await liveGrant(input.tenantId, tx);
    if (current) {
      const note = input.note ?? current.note;
      await tx
        .update(circlsSupportGrants)
        .set({ expiresAt, note })
        .where(eq(circlsSupportGrants.id, current.id));
      await writeAudit(
        tx,
        { tenantId: input.tenantId, actorUserId: input.userId },
        'tenant.circls_support_extended',
        'circls_support_grant',
        current.id,
        { expiresAt: current.expiresAt.toISOString() },
        { expiresAt: expiresAt.toISOString(), note },
      );
      return null;
    }
    const [row] = await tx
      .insert(circlsSupportGrants)
      .values({
        tenantId: input.tenantId,
        requestedByUserId: input.userId,
        note: input.note,
        expiresAt,
      })
      .returning();
    await writeAudit(
      tx,
      { tenantId: input.tenantId, actorUserId: input.userId },
      'tenant.circls_support_granted',
      'circls_support_grant',
      row!.id,
      null,
      { expiresAt: expiresAt.toISOString(), note: input.note },
    );
    return row!;
  });
  if (created) await onCirclsSupportRequested(created.id);
  return circlsSupportStatus(input.tenantId);
}

/** Remove Circls now (the Team page's Remove). */
export async function endCirclsSupport(input: { tenantId: string; userId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await liveGrant(input.tenantId, tx);
    if (!current) throw new NotFound('Circls has no access to end', 'circls_support_not_active');
    const now = new Date();
    await tx
      .update(circlsSupportGrants)
      .set({ endedAt: now, endedByUserId: input.userId })
      .where(eq(circlsSupportGrants.id, current.id));
    await writeAudit(
      tx,
      { tenantId: input.tenantId, actorUserId: input.userId },
      'tenant.circls_support_ended',
      'circls_support_grant',
      current.id,
      { expiresAt: current.expiresAt.toISOString() },
      { endedAt: now.toISOString() },
    );
  });
}
