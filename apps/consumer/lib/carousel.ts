/** Index `delta` steps away from `index` in a ring of `count` slides. */
export function stepIndex(index: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/**
 * Which way a horizontal drag of `deltaX` px moves the carousel: dragging
 * left (negative) pulls the next slide in, dragging right the previous one.
 * Anything shorter than `threshold` is a tap or a wobble, not a swipe.
 */
export function swipeStep(deltaX: number, threshold: number): -1 | 0 | 1 {
  if (Math.abs(deltaX) < threshold) return 0;
  return deltaX < 0 ? 1 : -1;
}
