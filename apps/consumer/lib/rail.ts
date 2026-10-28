/**
 * Geometry for the home page's horizontal card rails (`HScroll`): whether
 * there is anything left to scroll towards either end, and which card an
 * arrow press brings to the front.
 */

/**
 * Zoomed and high-DPI screens leave `scrollLeft` fractional, so a rail
 * scrolled all the way can stop a fraction of a pixel short of its end.
 */
const EDGE_SLACK_PX = 1;

/** Whether a rail can scroll further back (`canPrev`) or forward (`canNext`). */
export function railEdges(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): { canPrev: boolean; canNext: boolean } {
  return {
    canPrev: scrollLeft > EDGE_SLACK_PX,
    canNext: scrollLeft + clientWidth < scrollWidth - EDGE_SLACK_PX,
  };
}

/**
 * How many whole cards fit in `visibleWidth`, never fewer than one. Cards that
 * share out a column are often a fractional width (four in a 1043px column
 * are 245.75px each) and some DOM measurements round, so a pixel of slack
 * keeps a card that does fit from being counted out.
 */
export function railCardsPerPage(visibleWidth: number, cardWidth: number, gap: number): number {
  const stride = cardWidth + gap;
  if (stride <= 0) return 1;
  // The last card in view needs no gap after it, hence `+ gap`.
  return Math.max(1, Math.floor((visibleWidth + gap + EDGE_SLACK_PX) / stride));
}

/** Index of the first card on the last page: the rail can't scroll past it. */
function lastPageStart(count: number, perPage: number): number {
  return Math.max(0, count - perPage);
}

/**
 * The card a rail currently starts at: the one whose snap offset is nearest
 * `scrollLeft`. Once the rail is scrolled to its end that is the last page's
 * first card, even when the end stops between snap offsets (cards that don't
 * fill the column exactly).
 */
export function railCurrentIndex(
  scrollLeft: number,
  maxScroll: number,
  offsets: number[],
  perPage: number,
): number {
  if (offsets.length === 0) return 0;
  if (scrollLeft >= maxScroll - EDGE_SLACK_PX) return lastPageStart(offsets.length, perPage);
  let nearest = 0;
  offsets.forEach((offset, i) => {
    if (Math.abs(offset - scrollLeft) < Math.abs(offsets[nearest]! - scrollLeft)) nearest = i;
  });
  return nearest;
}

/**
 * The card an arrow press brings to the front. Pages start at multiples of
 * `perPage` from the first card, so going back retraces the pages going
 * forward showed. The last page is pinned to the end of the rail, overlapping
 * the one before it when the cards don't divide evenly.
 */
export function railTargetIndex(from: number, dir: -1 | 1, perPage: number, count: number): number {
  if (dir === 1) {
    return Math.min((Math.floor(from / perPage) + 1) * perPage, lastPageStart(count, perPage));
  }
  return Math.max((Math.ceil(from / perPage) - 1) * perPage, 0);
}
