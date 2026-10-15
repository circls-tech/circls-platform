/**
 * Classes shared by the small action buttons that sit beside each other on a
 * listing — the wishlist heart and the share button — so the two never drift
 * apart in padding, border or shadow.
 */

/** A round chip for the corner of a card image. */
export const overlayChipClass = [
  'flex h-8 w-8 items-center justify-center rounded-full! border-[2px] border-ink bg-white shadow-offset-sm',
  'transition-transform duration-100 hover:scale-110 active:scale-95',
].join(' ');

/** A labelled pill for a detail-page header. */
export const inlinePillClass = [
  'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius)] border-[2px] border-ink bg-white',
  'px-3 py-1.5 text-sm font-semibold shadow-offset-sm',
  'transition-[transform,box-shadow] duration-100',
  'hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset',
  'active:translate-x-0 active:translate-y-0 active:shadow-none',
].join(' ');

/**
 * The row of chips in a card image's top-right corner. It is a sibling of
 * the card's link, not a child (a button inside an anchor is invalid HTML),
 * which also keeps the whole card clickable around it.
 */
export const cardChipRowClass = 'absolute right-2.5 top-2.5 z-10 flex items-center gap-1.5';

/**
 * The pill group in a detail-page header. It wraps into a stack where the
 * title's longest word plus two pills won't fit (phones).
 */
export const headerPillRowClass = 'mt-1 flex flex-wrap items-start justify-end gap-2 sm:shrink-0';
