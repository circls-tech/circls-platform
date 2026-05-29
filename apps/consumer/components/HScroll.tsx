import Link from 'next/link';
import type { ReactNode } from 'react';

/** A landing-page section: heading + optional "View all" + a horizontal,
 *  scroll-snapping row of cards (peeking next card signals more). */
export function HScroll({
  title,
  viewAllHref,
  children,
}: {
  title: string;
  viewAllHref?: string;
  children: ReactNode;
}) {
  return (
    <section className="py-6">
      <div className="mx-auto mb-3 flex max-w-6xl items-baseline justify-between px-4">
        <h2 className="font-display text-2xl font-semibold text-ink">{title}</h2>
        {viewAllHref && (
          <Link href={viewAllHref} className="text-sm font-semibold text-gold-600 hover:underline">
            View all →
          </Link>
        )}
      </div>
      <div className="mx-auto flex max-w-6xl snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 [scrollbar-width:thin]">
        {children}
      </div>
    </section>
  );
}
