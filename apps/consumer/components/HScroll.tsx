'use client';
import Link from 'next/link';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Chevron } from '@/components/Chevron';
import { railCardsPerPage, railCurrentIndex, railEdges, railTargetIndex } from '@/lib/rail';
import { LIFT } from '@/lib/ui';

/**
 * The row sizes and spaces its cards itself, so pages pass them in bare.
 * Below lg the column is the whole screen, and a fixed 260px card lets the
 * next one peek in at the screen edge. From lg up the column has margins
 * beside it, where a 260px card left a sliver of the next one hanging
 * mid-page that read as a layout bug; there four cards and three gaps fill
 * the column exactly and the arrows show there is more. The lg gap is wider
 * than the 1rem side padding, so the next card starts past the clip edge
 * rather than exactly on it, where sub-pixel rounding leaked a hairline of
 * its border.
 */
const RAIL_CLASS = [
  'mx-auto flex max-w-6xl snap-x snap-mandatory overflow-x-auto px-4 pb-4 pt-1',
  // scroll-px-4 snaps cards to the column, level with the heading.
  'scroll-px-4 gap-(--rail-gap) [--rail-gap:1rem] lg:[--rail-gap:1.25rem]',
  '*:w-[260px] *:shrink-0 *:snap-start lg:*:w-[calc((100%_-_3_*_var(--rail-gap))/4)]',
  // From md up the arrows stand in for the scrollbar. scrollbar-width hides
  // it in current browsers; the WebKit pseudo-element in Safari before 18.2.
  '[scrollbar-width:thin] md:[scrollbar-width:none] md:[&::-webkit-scrollbar]:hidden',
].join(' ');

/**
 * Same ink chip as the card corner buttons (see chips.ts). `rounded-full!`
 * beats the global `*:focus-visible` radius, which would otherwise square the
 * circle off while focused.
 */
const ARROW_CLASS =
  'flex h-9 w-9 items-center justify-center rounded-full! border-[2px] border-ink bg-white text-ink shadow-offset-sm transition-[transform,box-shadow] duration-100';

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
  return (
    <button
      type="button"
      // aria-disabled, not disabled: a disabled button drops keyboard focus,
      // so pressing Enter through to the last page would throw the user back
      // to the top of the page.
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      aria-controls={controls}
      aria-label={`${title}: scroll ${dir}`}
      className={`${ARROW_CLASS} ${disabled ? 'cursor-default opacity-35 shadow-none' : LIFT}`}
    >
      <Chevron dir={dir} className="h-4 w-4" strokeWidth={2.75} />
    </button>
  );
}

/** A landing-page section: heading + optional "View all" + a horizontal,
 *  scroll-snapping row of cards. On desktop arrow buttons page through it. */
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
  // The card an arrow press is still smooth-scrolling to, so a second press
  // carries on from there rather than from wherever the animation is.
  const pendingRef = useRef<number | null>(null);
  const railId = useId();
  const [edges, setEdges] = useState({ canPrev: false, canNext: false });

  // Re-measured on scroll, on resize, and when the cards change (a new
  // location can shrink a rail until everything fits).
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const next = railEdges(el.scrollLeft, el.scrollWidth, el.clientWidth);
      setEdges((prev) =>
        prev.canPrev === next.canPrev && prev.canNext === next.canNext ? prev : next,
      );
    };
    const onScroll = () => {
      update();
      // Scroll events stop when a smooth scroll ends.
      clearTimeout(settle);
      settle = setTimeout(() => {
        pendingRef.current = null;
      }, 150);
    };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(el);
    const cards = new MutationObserver(update);
    cards.observe(el, { childList: true });
    return () => {
      clearTimeout(settle);
      el.removeEventListener('scroll', onScroll);
      resize.disconnect();
      cards.disconnect();
    };
  }, []);

  function page(dir: -1 | 1) {
    const el = railRef.current;
    const cards = el ? Array.from(el.children) : [];
    if (!el || cards.length === 0) return;
    const style = getComputedStyle(el);
    const padLeft = parseFloat(style.paddingLeft);
    const box = el.getBoundingClientRect();
    // Each card's snap offset (the scrollLeft that lines it up with the
    // heading), measured rather than multiplied out so fractional card
    // widths can't drift.
    const columnLeft = box.left + padLeft - el.scrollLeft;
    const offsets = cards.map((card) => card.getBoundingClientRect().left - columnLeft);
    const perPage = railCardsPerPage(
      box.width - padLeft - parseFloat(style.paddingRight),
      cards[0]!.getBoundingClientRect().width,
      parseFloat(style.columnGap) || 0,
    );
    const from =
      pendingRef.current ??
      railCurrentIndex(el.scrollLeft, el.scrollWidth - el.clientWidth, offsets, perPage);
    const to = railTargetIndex(from, dir, perPage, cards.length);
    pendingRef.current = to;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Landing exactly on a snap offset leaves the mandatory snap nothing to
    // correct mid-animation.
    el.scrollTo({ left: offsets[to]!, behavior: reduce ? 'auto' : 'smooth' });
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
      <div ref={railRef} id={railId} className={RAIL_CLASS}>
        {children}
      </div>
    </section>
  );
}
