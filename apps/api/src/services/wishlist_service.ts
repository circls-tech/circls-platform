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
 * shows.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { wishlistItems, type WishlistItemType } from '../db/schema/wishlist_items.js';
import { NotFound } from '../lib/errors.js';
import {
  listPublicEventsByIds,
  listPublicMembershipsByIds,
  listPublicVenuesByIds,
  type PublicEventWithVenue,
  type PublicMembershipWithScope,
  type PublicVenue,
} from './consumer_service.js';

export const WISHLIST_ITEM_TYPES = ['event', 'membership', 'venue'] as const satisfies readonly WishlistItemType[];
export type { WishlistItemType };

/** Just the liked ids, per type — what the cards need to paint their hearts. */
export interface WishlistIds {
  events: string[];
  memberships: string[];
  venues: string[];
}

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

/** Whether `itemId` is a listing the public catalogue shows right now. */
async function isPubliclyVisible(itemType: WishlistItemType, itemId: string): Promise<boolean> {
  switch (itemType) {
    case 'event':
      return (await listPublicEventsByIds([itemId])).length > 0;
    case 'membership':
      return (await listPublicMembershipsByIds([itemId])).length > 0;
    case 'venue':
      return (await listPublicVenuesByIds([itemId])).length > 0;
  }
}

/**
 * Like a listing. Idempotent: liking something already on the wishlist keeps
 * the original `likedAt`. 404 (with the item type's usual code) when the
 * listing does not exist or is not publicly visible — the same answer the
 * detail endpoint would give, so a like can't be used to probe for hidden ids.
 */
export async function addToWishlist(
  userId: string,
  itemType: WishlistItemType,
  itemId: string,
): Promise<void> {
  if (!(await isPubliclyVisible(itemType, itemId))) {
    const [message, code] = NOT_FOUND[itemType];
    throw new NotFound(message, code);
  }
  await db.insert(wishlistItems).values({ userId, itemType, itemId }).onConflictDoNothing();
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
  const rows = await db
    .select({ itemType: wishlistItems.itemType, itemId: wishlistItems.itemId })
    .from(wishlistItems)
    .where(eq(wishlistItems.userId, userId))
    .orderBy(desc(wishlistItems.createdAt));
  const ids: WishlistIds = { events: [], memberships: [], venues: [] };
  for (const r of rows) {
    if (r.itemType === 'event') ids.events.push(r.itemId);
    else if (r.itemType === 'membership') ids.memberships.push(r.itemId);
    else ids.venues.push(r.itemId);
  }
  return ids;
}

/** The hydrated wishlist: only listings that are publicly visible right now. */
export async function getWishlist(userId: string): Promise<Wishlist> {
  const rows = await db
    .select({
      itemType: wishlistItems.itemType,
      itemId: wishlistItems.itemId,
      likedAt: wishlistItems.createdAt,
    })
    .from(wishlistItems)
    .where(eq(wishlistItems.userId, userId))
    .orderBy(desc(wishlistItems.createdAt));

  const likedAt = new Map<string, Date>();
  const ids: WishlistIds = { events: [], memberships: [], venues: [] };
  for (const r of rows) {
    likedAt.set(`${r.itemType}:${r.itemId}`, r.likedAt);
    if (r.itemType === 'event') ids.events.push(r.itemId);
    else if (r.itemType === 'membership') ids.memberships.push(r.itemId);
    else ids.venues.push(r.itemId);
  }

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
