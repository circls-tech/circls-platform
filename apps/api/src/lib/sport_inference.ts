/**
 * Pure helper: infer the canonical sport name from an array of freeform tags.
 *
 * Each tag is lowercased + trimmed before matching. The first tag (in
 * left-to-right order) whose normalised form appears in the map wins.
 * Returns null if no tag matches.
 */

const SPORT_MAP: Record<string, string> = {
  // football
  football:    'football',
  '5-a-side':  'football',
  '7-a-side':  'football',
  soccer:      'football',
  // cricket
  cricket:     'cricket',
  net:         'cricket',
  nets:        'cricket',
  // badminton
  badminton:   'badminton',
  shuttle:     'badminton',
  // tennis
  tennis:      'tennis',
  // basketball
  basketball:  'basketball',
  hoops:       'basketball',
  // swimming
  swimming:    'swimming',
  pool:        'swimming',
  // table-tennis
  'table-tennis': 'table-tennis',
  tt:          'table-tennis',
  'ping-pong': 'table-tennis',
  // squash
  squash:      'squash',
  // kabaddi
  kabaddi:     'kabaddi',
  // pickleball
  pickleball:  'pickleball',
};

export function inferSport(tags: string[]): string | null {
  for (const raw of tags) {
    const normalised = raw.trim().toLowerCase();
    if (normalised && Object.prototype.hasOwnProperty.call(SPORT_MAP, normalised)) {
      return SPORT_MAP[normalised]!;
    }
  }
  return null;
}
