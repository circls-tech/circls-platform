'use client';
import { useRouter } from 'next/navigation';

/**
 * A subtle, on-brand "← Back" affordance for detail pages. Uses the browser
 * history via next/navigation so it returns the user wherever they came from.
 */
export function BackBar({ className = '' }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => router.back()}
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
