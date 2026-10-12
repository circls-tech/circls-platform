/**
 * Consumer wishlist ("likes") — the heart on event, membership and venue cards
 * and the `/me/wishlist` page in the consumer web app.
 *
 * Private to the owner: nothing here is readable by partners or other
 * consumers, and nothing is counted or ranked. A like is only accepted for a
 * listing the consumer could see at that moment (the same public visibility
 * gate as the browse endpoints), and the wishlist read re-applies that gate,
 * so a listing that is later unpublished, archived, or whose tenant is hidden
 * silently drops out instead of surfacing something the catalogue no longer
 * shows. The one exception is a date of a recurring event: once that date has
 * passed the like rolls forward to the series' next upcoming date (see
 * {@link rollForwardSeriesLikes}), because what the person saved was "this
 * weekly thing", not one Friday.
 *
 * A wishlist holds at most {@link MAX_WISHLIST_ITEMS} likes, which also bounds
 * every read here — there is no pagination because there is nothing to page.
 */
import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { wishlistItems, type WishlistItemType } from '../db/schema/wishlist_items.js';
import { Conflict, NotFound } from '../lib/errors.js';
import {
  listPublicEventsByIds,
  listPublicMembershipsByIds,
  listPublicVenuesByIds,
  nextSeriesOccurrenceFor,
  publicEventIdsAmong,
  publicMembershipIdsAmong,
  publicVenueIdsAmong,
  type PublicEventWithVenue,
  type PublicMembershipWithScope,
  type PublicVenue,
} from './consumer_service.js';

export const WISHLIST_ITEM_TYPES = ['event', 'membership', 'venue'] as const satisfies readonly WishlistItemType[];
export type { WishlistItemType };

/** The most likes one consumer may hold across all three types. */
export const MAX_WISHLIST_ITEMS = 200;

/** Just the liked ids, per type — what the cards need to paint their hearts. */
export interface WishlistIds {
  events: string[];
  memberships: string[];
  venues: string[];
}

/** Which `WishlistIds` bucket holds each item type. */
const BUCKET: Record<WishlistItemType, keyof WishlistIds> = {
  event: 'events',
  membership: 'memberships',
  venue: 'venues',
};

/** A liked listing in its public card shape, plus when it was liked. */
export type WishlistEvent = PublicEventWithVenue & { likedAt: Date };
export type WishlistMembership = PublicMembershipWithScope & { likedAt: Date };
export type WishlistVenue = PublicVenue & { likedAt: Date };

/** The wishlist, hydrated: each section most-recently-liked first. */
export interface Wishlist {
  events: WishlistEvent[];
  memberships: WishlistMembership[];
  venues: WishlistVenue[];
}

const NOT_FOUND: Record<WishlistItemType, [string, string]> = {
  event: ['Event not found', 'event_not_found'],
  membership: ['Membership not found', 'membership_not_found'],
  venue: ['Venue not found', 'venue_not_found'],
};

/** The 404 the matching detail endpoint would give for this item type. */
export function wishlistNotFound(itemType: WishlistItemType): NotFound {
  const [message, code] = NOT_FOUND[itemType];
  return new NotFound(message, code);
}

/** Whether `itemId` is a listing the public catalogue shows right now — an
 *  existence check, no card hydration. */
async function isPubliclyVisible(itemType: WishlistItemType, itemId: string): Promise<boolean> {
  const among = {
    event: publicEventIdsAmong,
    membership: publicMembershipIdsAmong,
    venue: publicVenueIdsAmong,
  }[itemType];
  return (await among([itemId])).has(itemId);
}

interface LikeRow {
  itemType: WishlistItemType;
  itemId: string;
  likedAt: Date;
}

/** The user's likes, most recent first. Bounded by {@link MAX_WISHLIST_ITEMS}. */
async function listLikes(userId: string): Promise<LikeRow[]> {
  return db
    .select({
      itemType: wishlistItems.itemType,
      itemId: wishlistItems.itemId,
      likedAt: wishlistItems.createdAt,
    })
    .from(wishlistItems)
    .where(eq(wishlistItems.userId, userId))
    .orderBy(desc(wishlistItems.createdAt))
    .limit(MAX_WISHLIST_ITEMS);
}

/** Group like rows into the per-type id lists, preserving their order. */
function toWishlistIds(rows: Pick<LikeRow, 'itemType' | 'itemId'>[]): WishlistIds {
  const ids: WishlistIds = { events: [], memberships: [], venues: [] };
  for (const r of rows) ids[BUCKET[r.itemType]].push(r.itemId);
  return ids;
}

/**
 * Like a listing. Idempotent: liking something already on the wishlist keeps
 * the original `likedAt`. 404 (with the item type's usual code) when the
 * listing does not exist or is not publicly visible — the same answer the
 * detail endpoint would give, so a like can't be used to probe for hidden ids.
 * 409 `wishlist_full` once the wishlist holds {@link MAX_WISHLIST_ITEMS}.
 */
export async function addToWishlist(
  userId: string,
  itemType: WishlistItemType,
  itemId: string,
): Promise<void> {
  if (!(await isPubliclyVisible(itemType, itemId))) throw wishlistNotFound(itemType);
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ itemId: wishlistItems.itemId })
      .from(wishlistItems)
      .where(
        and(
          eq(wishlistItems.userId, userId),
          eq(wishlistItems.itemType, itemType),
          eq(wishlistItems.itemId, itemId),
        ),
      );
    if (existing) return;
    const [total] = await tx
      .select({ n: count() })
      .from(wishlistItems)
      .where(eq(wishlistItems.userId, userId));
    if ((total?.n ?? 0) >= MAX_WISHLIST_ITEMS) {
      throw new Conflict(
        `Your wishlist is full (${MAX_WISHLIST_ITEMS} items). Remove something to save more.`,
        'wishlist_full',
        { max: MAX_WISHLIST_ITEMS },
      );
    }
    // Two concurrent first likes of the same item both pass the select above;
    // the primary key makes the second a no-op rather than an error.
    await tx.insert(wishlistItems).values({ userId, itemType, itemId }).onConflictDoNothing();
  });
}

/** Unlike a listing. Idempotent: a row that isn't there is not an error. */
export async function removeFromWishlist(
  userId: string,
  itemType: WishlistItemType,
  itemId: string,
): Promise<void> {
  await db
    .delete(wishlistItems)
    .where(
      and(
        eq(wishlistItems.userId, userId),
        eq(wishlistItems.itemType, itemType),
        eq(wishlistItems.itemId, itemId),
      ),
    );
}

/**
 * Every liked id, per type, most recent first. Includes ids whose listing is
 * no longer visible — this is the cheap "which hearts are filled" read, and a
 * card the user can see is by definition visible.
 */
export async function listWishlistIds(userId: string): Promise<WishlistIds> {
  return toWishlistIds(await listLikes(userId));
}

/**
 * Move likes on event dates that are no longer public onto the next upcoming
 * date of the same series, keeping the original `likedAt`. Returns the rows
 * with those ids swapped. A like whose series has nothing upcoming is left as
 * is (and drops out of the hydrated read like any past event); if the next
 * date is already liked, the stale row is simply removed.
 */
async function rollForwardSeriesLikes(userId: string, rows: LikeRow[]): Promise<LikeRow[]> {
  const eventIds = rows.filter((r) => r.itemType === 'event').map((r) => r.itemId);
  if (eventIds.length === 0) return rows;
  const visible = await publicEventIdsAmong(eventIds);
  const stale = eventIds.filter((id) => !visible.has(id));
  if (stale.length === 0) return rows;
  const next = await nextSeriesOccurrenceFor(stale);
  if (next.size === 0) return rows;

  const alreadyLiked = new Set(eventIds);
  await db.transaction(async (tx) => {
    for (const [from, to] of next) {
      if (alreadyLiked.has(to)) {
        await tx
          .delete(wishlistItems)
          .where(and(eq(wishlistItems.userId, userId), eq(wishlistItems.itemType, 'event'), eq(wishlistItems.itemId, from)));
      } else {
        await tx
          .update(wishlistItems)
          .set({ itemId: to })
          .where(and(eq(wishlistItems.userId, userId), eq(wishlistItems.itemType, 'event'), eq(wishlistItems.itemId, from)));
        alreadyLiked.add(to);
      }
    }
  });

  const seen = new Set<string>();
  const out: LikeRow[] = [];
  for (const r of rows) {
    const itemId = r.itemType === 'event' ? (next.get(r.itemId) ?? r.itemId) : r.itemId;
    const key = `${r.itemType}:${itemId}`;
    if (seen.has(key)) continue; // the stale row that collapsed into an existing like
    seen.add(key);
    out.push({ ...r, itemId });
  }
  return out;
}

/** The hydrated wishlist: only listings that are publicly visible right now. */
export async function getWishlist(userId: string): Promise<Wishlist> {
  const rows = await rollForwardSeriesLikes(userId, await listLikes(userId));
  const likedAt = new Map(rows.map((r) => [`${r.itemType}:${r.itemId}`, r.likedAt]));
  const ids = toWishlistIds(rows);

  const [events, memberships, venues] = await Promise.all([
    listPublicEventsByIds(ids.events),
    listPublicMembershipsByIds(ids.memberships),
    listPublicVenuesByIds(ids.venues),
  ]);

  // The batch reads return rows in storage order; put each section back in
  // liked order (most recent first), which is what the page shows.
  const stamp = <T extends { id: string }>(type: WishlistItemType, items: T[]) =>
    items
      .map((item) => ({ ...item, likedAt: likedAt.get(`${type}:${item.id}`)! }))
      .sort((a, b) => b.likedAt.getTime() - a.likedAt.getTime());

  return {
    events: stamp('event', events),
    memberships: stamp('membership', memberships),
    venues: stamp('venue', venues),
  };
}

