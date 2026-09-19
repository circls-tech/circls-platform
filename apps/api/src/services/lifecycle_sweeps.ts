import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLog } from '../db/schema/index.js';

/**
 * Housekeeping the worker runs on a timer: things that should change state
 * because time passed, not because anyone did anything.
 *
 * Both sweeps wait a full day past the end before acting. That is the ask —
 * "one full day after the end date" — and it is also the safe side: an event
 * that overran, or a member who comes in on their last evening, is never
 * shelved while it could still matter.
 *
 * Each is a single set-based UPDATE, so a run is one round trip however large
 * the backlog, and each writes an audit row per change with no actor. That is
 * how the audit log already records system-initiated changes, and it keeps
 * "who expired this member?" answerable.
 */

/** How long after an end the sweeps wait. */
export const LIFECYCLE_GRACE = '1 day';

/**
 * Mark memberships whose window closed more than a day ago as `expired`.
 *
 * Nothing wrote `expired` before this — the value was in the enum from the
 * start, but every membership that ended kept reading `active` indefinitely.
 *
 * Only `active` rows move. `cancelled` is a deliberate partner or customer
 * decision and must not be overwritten by the clock.
 *
 * Capacity is unaffected: tier capacity counts every row that is not
 * `cancelled`, so an expired member still holds the seat they held before.
 */
export async function expireLapsedMemberships(now: Date = new Date()): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      update user_memberships um
         set status = 'expired'
        from memberships m
       where m.id = um.membership_id
         and um.status = 'active'
         and um.ends_at < ${now.toISOString()}::timestamptz - ${LIFECYCLE_GRACE}::interval
      returning um.id, m.tenant_id, um.ends_at
    `)) as unknown as { id: string; tenant_id: string; ends_at: Date | string }[];

    if (rows.length > 0) {
      await tx.insert(auditLog).values(
        rows.map((r) => ({
          tenantId: r.tenant_id,
          actorUserId: null,
          action: 'membership.member_expired',
          entityType: 'user_membership',
          entityId: r.id,
          before: { status: 'active' },
          after: { status: 'expired', endsAt: new Date(r.ends_at).toISOString() },
        })),
      );
    }
    return rows.length;
  });
}

/**
 * Put events on the partner's archive shelf a day after they end.
 *
 * A published event that has run is moved to `completed` on the way through,
 * because the rest of the code holds that a published event is never archived
 * (reopening one clears `archived_at` for the same reason). `completed` already
 * means "it ran, or is over", so this is the state it was in all along.
 * Consumers see no change: every public query also requires
 * `ends_at >= now()`, so a past event was already invisible to them.
 *
 * `pending_review` is left alone, matching the manual archive rule — it is
 * still sitting in the admin review queue.
 *
 * An event is only ever swept once: `auto_archived_at` is stamped here and the
 * sweep skips any row where it is set. Without that, a partner who restored an
 * event from the archive would find it shelved again within the hour.
 */
export async function autoArchiveEndedEvents(now: Date = new Date()): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      with due as (
        select id, status
          from events
         where archived_at is null
           and auto_archived_at is null
           and status in ('draft', 'published', 'cancelled', 'rejected', 'completed')
           and ends_at < ${now.toISOString()}::timestamptz - ${LIFECYCLE_GRACE}::interval
         for update
      )
      update events e
         set archived_at      = ${now.toISOString()}::timestamptz,
             auto_archived_at = ${now.toISOString()}::timestamptz,
             status           = case when due.status = 'published'
                                     then 'completed'::event_status
                                     else due.status end
        from due
       where e.id = due.id
      returning e.id, e.tenant_id, due.status as before_status, e.status as after_status
    `)) as unknown as {
      id: string;
      tenant_id: string;
      before_status: string;
      after_status: string;
    }[];

    if (rows.length > 0) {
      await tx.insert(auditLog).values(
        rows.map((r) => ({
          tenantId: r.tenant_id,
          actorUserId: null,
          action: 'event.auto_archived',
          entityType: 'event',
          entityId: r.id,
          before: { status: r.before_status, archived: false },
          after: { status: r.after_status, archived: true },
        })),
      );
    }
    return rows.length;
  });
}
