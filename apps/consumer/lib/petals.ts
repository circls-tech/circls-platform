/** The eight brand petal pastels (see the brand sheet's navigator row). */
export const PETALS = [
  '#FFB0A3', // salmon
  '#FCE38A', // butter
  '#BCE3A0', // lime
  '#9CE0D4', // mint
  '#F9B4D4', // pink
  '#CDBBF7', // lilac
  '#A9C9F2', // sky
  '#FFD2A1', // peach
] as const;

/** Stable petal for a name — the same organiser gets the same colour on every
 *  card and page. */
export function petalFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return PETALS[h % PETALS.length]!;
}
