'use client';
import type { ReactNode } from 'react';

export interface StickyActionBarProps {
  /** Left-hand summary, e.g. "2 slots · ₹600". */
  summary: ReactNode;
  /** Right-hand primary action (typically a <Button>). */
  action: ReactNode;
  /**
   * Tailwind max-width class used to centre the bar's content to the page's
   * own max-width on desktop (full-bleed on mobile). Defaults to max-w-5xl.
   */
  maxWidthClass?: string;
}

/**
 * A fixed bottom action bar — the primary CTA surface on detail pages.
 * Neobrutalist: white surface, thick ink top border, hard upward offset shadow,
 * safe-area aware. Pair with bottom padding (e.g. pb-28) on the page so it never
 * covers the last content.
 */
export function StickyActionBar({ summary, action, maxWidthClass = 'max-w-5xl' }: StickyActionBarProps) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t-[2.5px] border-ink bg-white shadow-[0_-5px_0_0_rgba(23,21,29,0.08)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div
        className={['mx-auto flex items-center justify-between gap-3 px-4 py-3', maxWidthClass].join(' ')}
      >
        <div className="min-w-0 text-sm font-medium text-ink">{summary}</div>
        <div className="shrink-0">{action}</div>
      </div>
    </div>
  );
}
