/**
 * The one step every listing type shares when a partner sends a listing to
 * Circls review: refuse while anything is missing, flip it to pending_review,
 * and audit it. A listing goes from `draft` (its first submission) or from
 * `rejected` (fixed in place after Circls asked for changes, and sent again).
 * Each type still loads and locks its own row (with its own not-found and
 * wrong-status codes) and decides what "missing" means — events need dates, a
 * location and a tier; plans a tier; venues and arenas nothing beyond their
 * name — then hands the rest here, so how a submission is recorded is
 * written once.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { arenas, auditLog, events, memberships, venues } from '../db/schema/index.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import { Conflict } from '../lib/errors.js';

export type ReviewableListingType = 'venue' | 'arena' | 'event' | 'membership';

/** The statuses a partner may send to review from. */
export type SubmittableStatus = 'draft' | 'rejected';

/** True when a listing in `status` may be sent to Circls review. */
export function isSubmittable(status: string): status is SubmittableStatus {
  return status === 'draft' || status === 'rejected';
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RowOf<T extends ReviewableListingType> = T extends 'venue'
  ? typeof venues.$inferSelect
  : T extends 'arena'
    ? typeof arenas.$inferSelect
    : T extends 'event'
      ? typeof events.$inferSelect
      : typeof memberships.$inferSelect;

async function flipToReview(tx: Tx, type: ReviewableListingType, id: string): Promise<unknown> {
  switch (type) {
    case 'venue':
      return (await tx.update(venues).set({ status: 'pending_review' }).where(eq(venues.id, id)).returning())[0];
    case 'arena':
      return (await tx.update(arenas).set({ status: 'pending_review' }).where(eq(arenas.id, id)).returning())[0];
    case 'event':
      // An event in review is never on the archive shelf; one shelved as a
      // draft or after a rejection comes back to the working list.
      return (
        await tx
          .update(events)
          .set({ status: 'pending_review', archivedAt: null })
          .where(eq(events.id, id))
          .returning()
      )[0];
    case 'membership':
      return (await tx.update(memberships).set({ status: 'pending_review' }).where(eq(memberships.id, id)).returning())[0];
  }
}

export async function submitForReview<T extends ReviewableListingType>(
  tx: Tx,
  ctx: AuditCtx,
  type: T,
  id: string,
  /** The status the caller locked the row in. */
  from: SubmittableStatus,
  /** What the listing still lacks; empty means it may go. */
  missing: readonly string[],
  /** Extra detail for the refusal and the audit row (a series id, say). */
  extra: Record<string, unknown> = {},
): Promise<RowOf<T>> {
  if (missing.length > 0) {
    throw new Conflict(`This ${type} is not complete yet`, `${type}_incomplete`, { ...extra, missing });
  }
  // Submitting takes an event off the archive shelf (see flipToReview); say so.
  let wasArchived = false;
  if (type === 'event') {
    const [ev] = await tx.select({ archivedAt: events.archivedAt }).from(events).where(eq(events.id, id)).limit(1);
    wasArchived = ev?.archivedAt != null;
  }
  const updated = await flipToReview(tx, type, id);
  await writeAudit(
    tx,
    ctx,
    `${type}.submitted_for_review`,
    type,
    id,
    { status: from, ...(wasArchived ? { archived: true } : {}) },
    { status: 'pending_review', ...(wasArchived ? { archived: false } : {}), ...extra },
  );
  return updated as RowOf<T>;
}

export interface ListingRejection {
  /** What Circls asked the partner to change; null when no reason was given. */
  reason: string | null;
  rejectedAt: string;
}

/**
 * Why Circls last rejected a listing, from its `listing.rejected` audit row.
 * Null when there is no such row (a listing rejected before reasons were
 * recorded still has its row; one never rejected has none).
 */
export async function latestRejection(
  type: ReviewableListingType,
  id: string,
): Promise<ListingRejection | null> {
  const [row] = await db
    .select({ after: auditLog.after, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, id), eq(auditLog.action, 'listing.rejected'), eq(auditLog.entityType, type)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!row) return null;
  const reason = row.after?.['reason'];
  return {
    reason: typeof reason === 'string' && reason.trim() ? reason : null,
    rejectedAt: row.createdAt.toISOString(),
  };
}
