'use client';
import type { MouseEvent } from 'react';
import type { WishlistItemType } from '@/lib/api/types';
import { listingUrl } from '@/lib/share';
import { useShareTap } from '@/lib/useShareTap';
import { inlinePillClass, overlayChipClass } from '@/components/chips';

/** The three-dots-and-lines share glyph (the Android / Material one). */
export function ShareIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.59 13.51l6.83 3.98" />
      <path d="M15.41 6.51l-6.82 3.98" />
    </svg>
  );
}

export function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

const NOTE_MS = 2500;

/**
 * One tap to share a listing: the device's share sheet where there is one
 * (phones, Safari, Chrome and Edge on Windows and macOS), a copied link
 * everywhere else.
 *
 * Two faces, matching `LikeButton`:
 *   - `overlay` (default) — a round chip for the corner of a card image. It
 *     sits OUTSIDE the card's link (a button inside an anchor is invalid HTML)
 *     and stops the click reaching anything behind it.
 *   - `inline` — a labelled "Share" pill for detail-page headers.
 *
 * A copied link is confirmed inside the button itself (a tick, and "Copied"
 * on the pill) rather than with a note beside it: the button shares a row
 * with the heart, and anything that widened it would push the heart off a
 * phone-width card. If neither sharing nor the clipboard is allowed, the
 * button says so in its tooltip and to screen readers.
 *
 * The link is the listing's canonical path (e.g. `/events/<id>`) on whichever
 * host served the page, built at click time so it never carries the current
 * URL's query string (a preview token, say). Pages in preview mode should not
 * render this at all: the listing is not public yet, so the link would 404
 * for everyone it is sent to.
 *
 * Every tap is logged as a `share` activity event with its outcome, so the
 * admin reports can count shares per listing and per consumer. A dismissed
 * sheet is logged too (it was a tap), but the reports only count `shared`
 * and `copied` as shares.
 */
export function ShareButton({
  title,
  text,
  itemType,
  itemId,
  variant = 'overlay',
  className = '',
}: {
  /** The listing's name: the share sheet's title and the accessible label. */
  title: string;
  /** An optional line under the title (date, venue). */
  text?: string;
  itemType: WishlistItemType;
  itemId: string;
  variant?: 'overlay' | 'inline';
  className?: string;
}) {
  const { last, recent, tap } = useShareTap(NOTE_MS);

  function onClick(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    void tap({ title, text, url: listingUrl(window.location.origin, itemType, itemId) }, { itemType, itemId });
  }

  // The sheet is its own confirmation; only the quieter outcomes get a note,
  // and only for a moment.
  const outcome = recent ? last : null;
  const copied = outcome === 'copied';
  const note = copied ? 'Link copied' : outcome === 'unavailable' ? 'Copy the address bar to share' : null;
  const icon = copied ? <CheckIcon className="h-4 w-4" /> : <ShareIcon className="h-4 w-4" />;
  // The name tracks the visible label so "click Copied" works for voice control.
  const label = copied ? `Copied link to ${title}` : `Share ${title}`;
  // Screen readers hear the outcome the tick shows sighted users. The live
  // region is always in the DOM: one that appears together with its text is
  // usually not announced.
  const status = (
    <span role="status" className="sr-only">
      {note}
    </span>
  );

  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={note ?? undefined}
        className={`${inlinePillClass} text-ink ${className}`}
      >
        {icon}
        <span>{copied ? 'Copied' : 'Share'}</span>
        {status}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={note ?? undefined}
      className={`${overlayChipClass} text-ink ${className}`}
    >
      {icon}
      {status}
    </button>
  );
}
