/** The eight brand petal pastels by name (see the brand sheet's navigator row). */
export const PETAL = {
  salmon: '#FFB0A3',
  butter: '#FCE38A',
  lime: '#BCE3A0',
  mint: '#9CE0D4',
  pink: '#F9B4D4',
  lilac: '#CDBBF7',
  sky: '#A9C9F2',
  peach: '#FFD2A1',
} as const;

export const PETALS = Object.values(PETAL);

/** Stable petal for a name — the same organiser gets the same colour on every
 *  card and page. */
export function petalFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return PETALS[h % PETALS.length]!;
}
