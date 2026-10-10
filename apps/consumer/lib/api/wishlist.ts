import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/firebase/auth_context';
import { isLiked, withLike } from '@/lib/wishlist';
import { apiFetch } from './client';
import type { Wishlist, WishlistIds, WishlistItemType } from './types';

// Query keys are suffixed with the Firebase uid so one person's hearts never
// show for the next one to sign in on the same browser.
const idsKey = (uid: string | undefined) => ['wishlist-ids', uid] as const;
const wishlistKey = (uid: string | undefined) => ['wishlist', uid] as const;

/** Every liked id per type — what the hearts on cards read. Signed-out
 *  visitors never fetch (nothing is liked). */
export function useWishlistIds() {
  const { user } = useAuth();
  return useQuery({
    queryKey: idsKey(user?.uid),
    queryFn: () => apiFetch<WishlistIds>('/v1/consumer/me/wishlist/ids'),
    enabled: Boolean(user),
    // Hearts across a page share one fetch; a minute of staleness is fine
    // because every toggle writes the cache directly.
    staleTime: 60_000,
  });
}

/** Whether the signed-in user has liked this listing. */
export function useIsLiked(itemType: WishlistItemType, itemId: string): boolean {
  const ids = useWishlistIds();
  return isLiked(ids.data, itemType, itemId);
}

/** The hydrated wishlist for `/me/wishlist`. */
export function useWishlist() {
  const { user } = useAuth();
  return useQuery({
    queryKey: wishlistKey(user?.uid),
    queryFn: () => apiFetch<Wishlist>('/v1/consumer/me/wishlist'),
    enabled: Boolean(user),
  });
}

export interface ToggleLikeInput {
  itemType: WishlistItemType;
  itemId: string;
  /** The state to move TO. */
  liked: boolean;
}

/**
 * Like / unlike. Optimistic: the heart flips at once and rolls back if the
 * request fails. The hydrated wishlist is refetched afterwards so the
 * `/me/wishlist` page agrees with the hearts.
 */
export function useToggleLike() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const key = idsKey(user?.uid);
  return useMutation({
    mutationFn: ({ itemType, itemId, liked }: ToggleLikeInput) =>
      apiFetch<{ liked: boolean }>(`/v1/consumer/me/wishlist/${itemType}/${itemId}`, {
        method: liked ? 'PUT' : 'DELETE',
      }),
    onMutate: async ({ itemType, itemId, liked }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<WishlistIds>(key);
      qc.setQueryData<WishlistIds>(key, (ids) => withLike(ids, itemType, itemId, liked));
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      // setQueryData ignores `undefined`, so when nothing had loaded yet the
      // optimistic entry must be dropped outright; the invalidation below then
      // refetches the truth.
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      else qc.removeQueries({ queryKey: key, exact: true });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: wishlistKey(user?.uid) });
    },
  });
}
