/**
 * Geometry for the home page's horizontal card rails (`HScroll`): whether
 * there is anything left to scroll towards either end, and how far one arrow
 * press moves the row.
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
 * How far one arrow press scrolls: as many whole cards as fit in
 * `visibleWidth` (never fewer than one), so the first card not yet in full
 * view becomes the first one in the row.
 */
export function railPageStep(visibleWidth: number, cardWidth: number, gap: number): number {
  const stride = cardWidth + gap;
  if (stride <= 0) return visibleWidth;
  // The last card in view needs no gap after it, hence `+ gap`.
  const cards = Math.max(1, Math.floor((visibleWidth + gap) / stride));
  return cards * stride;
}
