'use client';
import type { MouseEvent } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { useIsLiked, useToggleLike } from '@/lib/api/wishlist';
import type { WishlistItemType } from '@/lib/api/types';

function Heart({ filled, className = '' }: { filled: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

/**
 * The heart that saves a listing to the wishlist (`/me/wishlist`).
 *
 * Two faces:
 *   - `overlay` (default) — a round chip for the corner of a card image. The
 *     parent positions it; it sits OUTSIDE the card's link (a button inside an
 *     anchor is invalid HTML), so the click handler also stops the event from
 *     reaching anything behind it.
 *   - `inline` — a labelled pill ("Save" / "Saved") for detail-page headers.
 *
 * Signed-out visitors are sent to sign in and brought back to this page; the
 * like itself is not replayed afterwards (one tap, once they're back, is
 * clearer than a heart that fills on its own).
 */
export function LikeButton({
  itemType,
  itemId,
  name,
  variant = 'overlay',
  className = '',
}: {
  itemType: WishlistItemType;
  itemId: string;
  /** The listing's name, for the accessible label. */
  name: string;
  variant?: 'overlay' | 'inline';
  className?: string;
}) {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const liked = useIsLiked(itemType, itemId);
  const toggle = useToggleLike();

  function onClick(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!user) {
      router.push(`/login?redirect=${encodeURIComponent(pathname)}`);
      return;
    }
    toggle.mutate({ itemType, itemId, liked: !liked });
  }

  const label = liked ? `Remove ${name} from your wishlist` : `Save ${name} to your wishlist`;
  const colour = liked ? 'text-petal-red' : 'text-ink';

  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={liked}
        aria-label={label}
        className={[
          'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] border-[2px] border-ink bg-white',
          'px-3 py-1.5 text-sm font-semibold shadow-offset-sm',
          'transition-[transform,box-shadow] duration-100',
          'hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset',
          'active:translate-x-0 active:translate-y-0 active:shadow-none',
          colour,
          className,
        ].join(' ')}
      >
        <Heart filled={liked} className="h-4 w-4" />
        <span className="text-ink">{liked ? 'Saved' : 'Save'}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={liked}
      aria-label={label}
      className={[
        'flex h-8 w-8 items-center justify-center rounded-full! border-[2px] border-ink bg-white shadow-offset-sm',
        'transition-transform duration-100 hover:scale-110 active:scale-95',
        colour,
        className,
      ].join(' ')}
    >
      <Heart filled={liked} className="h-4 w-4" />
    </button>
  );
}
