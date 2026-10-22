import { sql, type SQL } from 'drizzle-orm';

/**
 * The one definition of "a view" and "a share" in `consumer_activity`, for the
 * admin reports that count them (the consumer report and the per-listing
 * Engagement report). Both must agree, or a listing and the people who looked
 * at it would tell different stories.
 *
 * VIEWS are `item_view` rows, with the listing in `item_type` / `item_id`.
 * The web app logs that name; the Flutter app names its views after the
 * listing (`event_view`, `venue_view`, `membership_view`). The ingest rewrites
 * any `<item_type>_view` to `item_view` (normalizeActivityEventType), and
 * migration 0069 rewrote the rows stored before it, so readers only ever see
 * one name and a new per-type view name from either client is counted without
 * a change here. Likes and shares carry `item_type` too, so filtering on
 * `item_type` alone would count a share from a card as a view.
 *
 * SHARES. Both clients log a `share` on every tap of the share button, with
 * `props.outcome`: `shared` (sent through the share sheet), `copied` (link
 * copied, where there is no sheet), `dismissed` (sheet closed) or
 * `unavailable` / `failed` (nothing happened). Only the first two put a link
 * in someone's hands, so only they count as shares.
 *
 * LIKES are not here: they are read from `wishlist_items`, which both clients
 * write through the wishlist API, rather than from `like` / `unlike` activity
 * rows (which only say when a heart was tapped, not what is liked now).
 */
export const COMPLETED_SHARE_OUTCOMES = ['shared', 'copied'] as const;

/**
 * The event type an incoming activity event is stored under: a view named
 * after its item type (`event_view` with item type `event`) becomes
 * `item_view`; everything else is kept as sent.
 */
export function normalizeActivityEventType(eventType: string, itemType: string | null | undefined): string {
  return itemType && eventType === `${itemType}_view` ? 'item_view' : eventType;
}

const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** `<alias>` is a listing view. */
export function isViewSql(alias: string): SQL {
  return sql`${sql.raw(alias)}.event_type = 'item_view'`;
}

/** `<alias>` is a share that reached someone (sent or copied). */
export function isShareSql(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.event_type = 'share' AND ${a}.props->>'outcome' IN (${list(COMPLETED_SHARE_OUTCOMES)}))`;
}
