'use client';

import { useEffect, useState } from 'react';
import type { PostBookingRedirect } from '@/lib/api/types';

/** Seconds a forced redirect waits before opening — long enough to read the
 *  confirmation and hit "Stay here", short enough not to feel stuck. */
const COUNTDOWN_SECONDS = 5;

/** How the countdown ended: the tab opened, or the browser blocked it. */
type OpenOutcome = 'opened' | 'blocked';

/**
 * The API only stores http(s) links, but the value is partner-authored and
 * lands in an `href`, so re-check the scheme before trusting a row that may
 * predate that rule. Anything else renders as inert text.
 */
export function isSafeRedirectUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Host shown on the button so people can see where they're being sent. */
function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

/**
 * The organiser's next step after a confirmed booking — their blurb plus a link
 * out (a Google Form, a WhatsApp community, a waiver).
 *
 * `autoRedirect` arms the forced behaviour: on the confirmation screen a forced
 * redirect counts down and opens the link in a NEW tab, with a visible "Stay
 * here" escape — the customer keeps their confirmation (and booking reference)
 * on screen either way. Everywhere else (the booking page, where they may
 * return weeks later) the same redirect is just a link — nobody wants a booking
 * page that opens a form every time they visit it.
 */
export function PostBookingRedirectPanel({
  redirect,
  autoRedirect = false,
}: {
  redirect: PostBookingRedirect;
  autoRedirect?: boolean;
}) {
  const safe = isSafeRedirectUrl(redirect.url);
  const counting = autoRedirect && redirect.forced && safe;
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  const [cancelled, setCancelled] = useState(false);
  const [outcome, setOutcome] = useState<OpenOutcome | null>(null);

  // One timeout per tick (rather than an interval) so "Stay here" and unmount
  // both stop the clock through the normal cleanup path, and the open is an
  // effect rather than a side effect inside a state updater.
  useEffect(() => {
    if (!counting || cancelled || outcome) return;
    if (secondsLeft <= 0) {
      // A timer-driven open has no user gesture behind it, so popup blockers
      // may refuse it. Only a BLOCKED open returns null here — which is why the
      // `noopener` feature must not be passed: per the HTML spec window.open
      // returns null whenever noopener is set, success or not, so asking for it
      // would report every successful open as blocked. `target=_blank` is
      // already implicitly noopener in current browsers, and clearing `opener`
      // covers the rest.
      const opened = window.open(redirect.url, '_blank');
      if (opened) {
        try {
          opened.opener = null;
        } catch {
          // Cross-origin window: the browser already severed the reference.
        }
      }
      setOutcome(opened ? 'opened' : 'blocked');
      return;
    }
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [counting, cancelled, outcome, secondsLeft, redirect.url]);

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius)] border-[2px] border-ink bg-lav-soft px-4 py-3 shadow-offset-sm">
      <p className="text-sm font-medium text-[var(--color-ink)]">
        {redirect.description ?? 'The organiser has one more step for you.'}
      </p>

      {safe ? (
        <>
          <a
            href={redirect.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-2 rounded-[var(--radius)] border-[2px] border-ink bg-white px-3.5 py-1.5 font-display text-xs font-bold text-[var(--color-ink)] shadow-offset-sm hover:bg-surface-2"
          >
            {outcome === 'opened' ? 'Open again' : `Continue to ${hostOf(redirect.url)}`}
          </a>
          {counting && !cancelled && !outcome && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Opening this in a new tab in {secondsLeft}s.{' '}
              <button
                type="button"
                onClick={() => setCancelled(true)}
                className="font-semibold underline"
              >
                Stay here
              </button>
            </p>
          )}
          {outcome === 'opened' && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Opened in a new tab — this page is still here.
            </p>
          )}
          {outcome === 'blocked' && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              Your browser blocked the new tab — use the button above to open it.
            </p>
          )}
          {autoRedirect && (
            <p className="text-xs text-[var(--color-text-secondary)]">
              This link is also on your booking page.
            </p>
          )}
        </>
      ) : (
        // A link we won't turn into an href — show it as text so the customer
        // can still act on it, and so a broken row is visible rather than silent.
        <p className="break-all text-xs text-[var(--color-text-secondary)]">{redirect.url}</p>
      )}
    </div>
  );
}
