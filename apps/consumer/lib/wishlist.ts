import type { WishlistIds, WishlistItemType } from '@/lib/api/types';

/** Which `WishlistIds` bucket holds each item type. */
export const WISHLIST_BUCKET: Record<WishlistItemType, keyof WishlistIds> = {
  event: 'events',
  membership: 'memberships',
  venue: 'venues',
};

export const EMPTY_WISHLIST_IDS: WishlistIds = { events: [], memberships: [], venues: [] };

/** Whether `itemId` is on the wishlist. A missing cache (signed out, not yet
 *  loaded) reads as "not liked". */
export function isLiked(
  ids: WishlistIds | undefined,
  itemType: WishlistItemType,
  itemId: string,
): boolean {
  return ids?.[WISHLIST_BUCKET[itemType]].includes(itemId) ?? false;
}

/**
 * The ids with one like flipped — the optimistic cache write behind the
 * heart. Pure and non-mutating. A like puts the id FIRST (the server lists
 * most recent first); liking an id already present, or unliking one that
 * isn't, returns an equivalent list rather than a duplicate.
 */
export function withLike(
  ids: WishlistIds | undefined,
  itemType: WishlistItemType,
  itemId: string,
  liked: boolean,
): WishlistIds {
  const base = ids ?? EMPTY_WISHLIST_IDS;
  const bucket = WISHLIST_BUCKET[itemType];
  const rest = base[bucket].filter((id) => id !== itemId);
  return { ...base, [bucket]: liked ? [itemId, ...rest] : rest };
}
