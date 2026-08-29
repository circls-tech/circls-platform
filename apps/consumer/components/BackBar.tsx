'use client';
import { useRouter } from 'next/navigation';

/**
 * A subtle, on-brand "← Back" affordance for sub-pages. Prefers the browser
 * history via next/navigation so it returns the user wherever they came from.
 * When there is no history to return to — a scanned QR, a shared link, a new
 * tab — it falls back to `fallbackHref` so the button is never a dead end.
 */
export function BackBar({
  fallbackHref = '/',
  className = '',
}: {
  fallbackHref?: string;
  className?: string;
}) {
  const router = useRouter();

  function goBack() {
    // A fresh tab has a history length of 1; anything more means there is
    // somewhere within this session to go back to.
    if (typeof window !== 'undefined' && window.history.length > 1) {
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
