/**
 * Canonical interest categories a consumer can pick on their profile.
 * Stored as slugs in users.interests and used to drive recommendations.
 * The consumer app mirrors this list with display labels
 * (apps/consumer/lib/interests.ts) — keep the two in sync.
 */
export const INTEREST_SLUGS = [
  'sports',
  'dance',
  'music',
  'arts',
  'learning',
  'gaming',
  'outdoors',
  'wellness',
  'food',
  'social',
  'tech',
  'family',
] as const;

export type InterestSlug = (typeof INTEREST_SLUGS)[number];

const slugSet: ReadonlySet<string> = new Set(INTEREST_SLUGS);

export function isInterestSlug(value: string): value is InterestSlug {
  return slugSet.has(value);
}
