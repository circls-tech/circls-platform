/** The eight brand petal pastels by name (see the brand sheet's navigator row).
 *  CSS var references, not hexes — globals.css owns the actual values. Only
 *  valid where CSS runs (inline style / stylesheets), not for canvas or email. */
export const PETAL = {
  salmon: 'var(--color-pastel-salmon)',
  butter: 'var(--color-pastel-butter)',
  lime: 'var(--color-pastel-lime)',
  mint: 'var(--color-pastel-mint)',
  pink: 'var(--color-pastel-pink)',
  lilac: 'var(--color-pastel-lilac)',
  sky: 'var(--color-pastel-sky)',
  peach: 'var(--color-pastel-peach)',
} as const;

export const PETALS = Object.values(PETAL);

/** Stable petal for a name — the same organiser gets the same colour on every
 *  card and page. */
export function petalFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return PETALS[h % PETALS.length]!;
}
