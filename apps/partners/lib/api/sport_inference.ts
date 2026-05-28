/**
 * Tiny client-side mirror of the backend sport inference map.
 * Kept in sync manually — the source of truth is apps/api/src/lib/sport_inference.ts.
 */

const SPORT_MAP: Record<string, string> = {
  football: 'football', '5-a-side': 'football', '7-a-side': 'football', soccer: 'football',
  cricket: 'cricket', net: 'cricket', nets: 'cricket',
  badminton: 'badminton', shuttle: 'badminton',
  tennis: 'tennis',
  basketball: 'basketball', hoops: 'basketball',
  swimming: 'swimming', pool: 'swimming',
  'table-tennis': 'table-tennis', tt: 'table-tennis', 'ping-pong': 'table-tennis',
  squash: 'squash',
  kabaddi: 'kabaddi',
  pickleball: 'pickleball',
};

export function inferSport(tags: string[]): string | null {
  for (const raw of tags) {
    const n = raw.trim().toLowerCase();
    if (n && Object.prototype.hasOwnProperty.call(SPORT_MAP, n)) return SPORT_MAP[n]!;
  }
  return null;
}
