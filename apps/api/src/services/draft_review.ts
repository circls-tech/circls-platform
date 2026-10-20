/**
 * The one step every listing type shares when a partner sends a draft to
 * Circls review: refuse while anything is missing, flip draft →
 * pending_review, and audit it. Each type still loads and locks its own row
 * (with its own not-found and not-a-draft codes) and decides what "missing"
 * means — events need dates, a location and a tier; plans a tier; venues
 * nothing beyond their name — then hands the rest here, so how a submission
 * is recorded is written once.
 */
import { eq } from 'drizzle-orm';
import type { db } from '../db/client.js';
import { events, memberships, venues } from '../db/schema/index.js';
import { type AuditCtx, writeAudit } from '../lib/audit.js';
import { Conflict } from '../lib/errors.js';

export type DraftListingType = 'venue' | 'event' | 'membership';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RowOf<T extends DraftListingType> = T extends 'venue'
  ? typeof venues.$inferSelect
  : T extends 'event'
    ? typeof events.$inferSelect
    : typeof memberships.$inferSelect;

async function flipToReview(tx: Tx, type: DraftListingType, id: string): Promise<unknown> {
  switch (type) {
    case 'venue':
      return (await tx.update(venues).set({ status: 'pending_review' }).where(eq(venues.id, id)).returning())[0];
    case 'event':
      return (await tx.update(events).set({ status: 'pending_review' }).where(eq(events.id, id)).returning())[0];
    case 'membership':
      return (await tx.update(memberships).set({ status: 'pending_review' }).where(eq(memberships.id, id)).returning())[0];
  }
}

export async function submitDraftForReview<T extends DraftListingType>(
  tx: Tx,
  ctx: AuditCtx,
  type: T,
  id: string,
  /** What the draft still lacks; empty means it may go. */
  missing: readonly string[],
  /** Extra detail for the refusal and the audit row (a series id, say). */
  extra: Record<string, unknown> = {},
): Promise<RowOf<T>> {
  if (missing.length > 0) {
    throw new Conflict(`This ${type} is not complete yet`, `${type}_incomplete`, { ...extra, missing });
  }
  const updated = await flipToReview(tx, type, id);
  await writeAudit(tx, ctx, `${type}.submitted_for_review`, type, id, { status: 'draft' }, { status: 'pending_review', ...extra });
  return updated as RowOf<T>;
}
