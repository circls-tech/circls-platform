/**
 * Module-level stack shared by every portal overlay (Modal, SlideOver) so
 * stacked overlays behave correctly:
 *
 * - Escape closes only the TOPMOST open overlay (each overlay's keydown
 *   handler checks `isTopOverlay` before acting).
 * - The body-scroll lock is reference-counted: the original overflow value is
 *   captured when the first overlay registers and restored only when the last
 *   one unregisters, so nested open/close in any order can't unlock scroll
 *   under a still-open overlay or clobber the saved value.
 */
let stack: string[] = [];
let prevBodyOverflow: string | null = null;

/** Register an overlay as open (idempotent — re-push moves it to the top). */
export function pushOverlay(id: string): void {
  if (stack.length === 0) {
    prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  stack = [...stack.filter((x) => x !== id), id];
}

/** Unregister an overlay; restores body scroll when the stack empties. */
export function popOverlay(id: string): void {
  const next = stack.filter((x) => x !== id);
  if (next.length === stack.length) return;
  stack = next;
  if (stack.length === 0 && prevBodyOverflow !== null) {
    document.body.style.overflow = prevBodyOverflow;
    prevBodyOverflow = null;
  }
}

/** True when `id` is the topmost open overlay (the one Escape should close). */
export function isTopOverlay(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}
