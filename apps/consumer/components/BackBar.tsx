'use client';
import { useRouter } from 'next/navigation';
import { canGoBack } from '@/lib/nav/history_depth';

/**
 * A subtle, on-brand "← Back" affordance, in two flavours.
 *
 * By default it returns the visitor to the previous page they saw *within
 * circls*, falling back to `fallbackHref` when there is no such page — a
 * scanned QR, a shared link, a search result, a new tab — so the button is
 * never a dead end. That is what a detail page wants: back to the list you
 * came from.
 *
 * Pass `href` instead on the header's top-level tabs. Stepping back through
 * history there lands on whichever tab was browsed before, which reads as
 * sideways rather than out; a fixed destination makes the button mean one
 * thing on those pages — leave, to here.
 */
export function BackBar({
  href,
  fallbackHref = '/',
  className = '',
}: {
  /** Always go here, never through history. For the top-level tabs. */
  href?: string;
  /** Where to land when there is no in-app page to go back to. */
  fallbackHref?: string;
  className?: string;
}) {
  const router = useRouter();

  function goBack() {
    if (href) {
      router.push(href);
      return;
    }
    // Only step back through pages we navigated to ourselves. window.history
    // counts other origins too, and router.back() won't traverse to one, so
    // trusting it left the button inert for anyone arriving from a search
    // result or a shared link.
    if (canGoBack()) {
      router.back();
      return;
    }
    router.push(fallbackHref);
  }

  return (
    <button
      type="button"
      onClick={goBack}
      aria-label="Go back"
      className={[
        'mb-4 inline-flex items-center gap-1.5 rounded-[var(--radius)] border-[2px] border-ink bg-white',
        'px-3 py-1.5 text-sm font-semibold text-ink shadow-offset-sm',
        'transition-[transform,box-shadow] duration-100',
        'hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset',
        'active:translate-x-0 active:translate-y-0 active:shadow-none',
        className,
      ].join(' ')}
    >
      <span aria-hidden="true" className="text-base leading-none">←</span>
      Back
    </button>
  );
}
