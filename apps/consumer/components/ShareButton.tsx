'use client';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { shareLink, type ShareOutcome } from '@/lib/share';

function ShareIcon({ className = '' }: { className?: string }) {
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
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <path d="M16 6l-4-4-4 4" />
      <path d="M12 2v13" />
    </svg>
  );
}

function CheckIcon({ className = '' }: { className?: string }) {
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
 * One tap to share a listing: the device's share sheet where there is one, a
 * copied link everywhere else (most desktop browsers).
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
 * `path` is the listing's canonical path (e.g. `/events/<id>`); the origin is
 * added at click time so the link points at whichever host served the page
 * and never carries the current URL's query string (a preview token, say).
 */
export function ShareButton({
  title,
  text,
  path,
  variant = 'overlay',
  className = '',
}: {
  /** The listing's name: the share sheet's title and the accessible label. */
  title: string;
  /** An optional line under the title (date, venue). */
  text?: string;
  path: string;
  variant?: 'overlay' | 'inline';
  className?: string;
}) {
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  async function onClick(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    const url = `${window.location.origin}${path}`;
    const result = await shareLink({ title, text, url });
    // The sheet is its own confirmation; only the quieter outcomes need a note.
    if (result === 'shared' || result === 'dismissed') return;
    setOutcome(result);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOutcome(null), NOTE_MS);
  }

  const copied = outcome === 'copied';
  const note = copied ? 'Link copied' : outcome === 'unavailable' ? 'Copy the address bar to share' : null;
  const icon = copied ? <CheckIcon className="h-4 w-4" /> : <ShareIcon className="h-4 w-4" />;
  // Screen readers hear the outcome the tick shows sighted users.
  const status = note && (
    <span role="status" className="sr-only">
      {note}
    </span>
  );

  if (variant === 'inline') {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`Share ${title}`}
        title={note ?? undefined}
        className={[
          'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] border-[2px] border-ink bg-white',
          'px-3 py-1.5 text-sm font-semibold text-ink shadow-offset-sm',
          'transition-[transform,box-shadow] duration-100',
          'hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset',
          'active:translate-x-0 active:translate-y-0 active:shadow-none',
          className,
        ].join(' ')}
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
      aria-label={`Share ${title}`}
      title={note ?? undefined}
      className={[
        'flex h-8 w-8 items-center justify-center rounded-full! border-[2px] border-ink bg-white text-ink shadow-offset-sm',
        'transition-transform duration-100 hover:scale-110 active:scale-95',
        className,
      ].join(' ')}
    >
      {icon}
      {status}
    </button>
  );
}
