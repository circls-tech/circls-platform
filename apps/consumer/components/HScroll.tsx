'use client';
import Link from 'next/link';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { railEdges, railPageStep } from '@/lib/rail';

/**
 * Width and snap for a card in an HScroll rail. Below lg the column is the
 * whole screen, so a fixed 260px card lets the next one peek in at the screen
 * edge. From lg up the column has margins beside it, and a 260px card would
 * leave a sliver of the next one hanging mid-page, which read as a layout
 * bug; there four cards and the rail's three lg:gap-5 gaps fill the column
 * exactly, and the arrows show there is more.
 */
export const railCardClass = 'w-[260px] shrink-0 snap-start lg:w-[calc((100%_-_3.75rem)/4)]';

/**
 * Same ink chip as the card corner buttons (see chips.ts), with the Button
 * lift. `rounded-full!` beats the global `*:focus-visible` radius, which
 * would otherwise square the circle off while focused.
 */
const ARROW_CLASS = [
  'flex h-9 w-9 items-center justify-center rounded-full! border-[2px] border-ink bg-white text-ink shadow-offset-sm',
  'transition-[transform,box-shadow] duration-100',
  'enabled:hover:-translate-x-0.5 enabled:hover:-translate-y-0.5 enabled:hover:shadow-offset',
  'enabled:active:translate-x-0 enabled:active:translate-y-0 enabled:active:shadow-none',
  'disabled:cursor-default disabled:opacity-35 disabled:shadow-none',
].join(' ');

function RailArrow({
  dir,
  title,
  controls,
  disabled,
  onClick,
}: {
  dir: 'left' | 'right';
  title: string;
  controls: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const left = dir === 'left';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-controls={controls}
      aria-label={`${title}: scroll ${dir}`}
      className={ARROW_CLASS}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d={left ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} />
      </svg>
    </button>
  );
}

/** A landing-page section: heading + optional "View all" + a horizontal,
 *  scroll-snapping row of cards (size them with `railCardClass`). On desktop
 *  arrow buttons page through the row. */
export function HScroll({
  title,
  viewAllHref,
  children,
}: {
  title: string;
  viewAllHref?: string;
  children: ReactNode;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const railId = useId();
  const [edges, setEdges] = useState({ canPrev: false, canNext: false });

  // Re-measured on scroll, on resize, and whenever the cards change (a new
  // location can shrink a rail until everything fits).
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const update = () => {
      const next = railEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
      setEdges((prev) =>
        prev.canPrev === next.canPrev && prev.canNext === next.canNext ? prev : next,
      );
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      resize.disconnect();
    };
  }, [children]);

  function page(dir: -1 | 1) {
    const el = railRef.current;
    const card = el?.firstElementChild;
    if (!el || !(card instanceof HTMLElement)) return;
    const style = getComputedStyle(el);
    const step = railPageStep(
      el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      card.offsetWidth,
      parseFloat(style.columnGap) || 0,
    );
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * step, behavior: reduce ? 'auto' : 'smooth' });
  }

  return (
    <section className="py-6">
      <div className="mx-auto mb-2 flex max-w-6xl items-center gap-3 px-4">
        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-2xl font-extrabold text-ink">{title}</h2>
          {viewAllHref && (
            <Link href={viewAllHref} className="text-sm font-bold text-coral-deep hover:underline">
              View all →
            </Link>
          )}
        </div>
        {/* Arrows for mouse users, who can't swipe the row; phones and tablets
            scroll it directly. Hidden rather than removed when every card fits,
            so the header doesn't grow once the rail has been measured. */}
        <div
          className={`ml-auto hidden shrink-0 gap-2 md:flex ${
            edges.canPrev || edges.canNext ? '' : 'invisible'
          }`}
        >
          <RailArrow
            dir="left"
            title={title}
            controls={railId}
            disabled={!edges.canPrev}
            onClick={() => page(-1)}
          />
          <RailArrow
            dir="right"
            title={title}
            controls={railId}
            disabled={!edges.canNext}
            onClick={() => page(1)}
          />
        </div>
      </div>
      {/* scroll-px-4 snaps cards to the column, level with the heading, not
          to the padding outside it. lg:gap-5 is wider than that 1rem padding,
          so the card after the last full one starts past the clip edge rather
          than exactly on it, where sub-pixel rounding leaked a hairline of its
          border. From md up the arrows stand in for the scrollbar. */}
      <div
        ref={railRef}
        id={railId}
        className="mx-auto flex max-w-6xl snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-4 pt-1 [scrollbar-width:thin] md:[scrollbar-width:none] lg:gap-5"
      >
        {children}
      </div>
    </section>
  );
}
