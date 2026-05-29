export type CanonicalSport =
  | 'badminton' | 'tennis' | 'football' | 'cricket' | 'basketball'
  | 'swimming' | 'tableTennis' | 'squash' | 'gym' | 'pickleball'
  | 'bouldering' | 'running';

/** Canonical sport → self-hosted asset under public/sports/. */
export const SPORT_IMAGES: Record<CanonicalSport, string> = {
  badminton:   '/sports/badminton.jpg',
  tennis:      '/sports/tennis.jpg',
  football:    '/sports/football.jpg',
  cricket:     '/sports/cricket.jpg',
  basketball:  '/sports/basketball.jpg',
  swimming:    '/sports/swimming.jpg',
  tableTennis: '/sports/table-tennis.jpg',
  squash:      '/sports/squash.jpg',
  gym:         '/sports/gym.jpg',
  pickleball:  '/sports/pickleball.jpg',
  bouldering:  '/sports/bouldering.jpg',
  running:     '/sports/running.jpg',
};

/** Normalized tag (see `normalize`) → canonical sport. Includes self-maps. */
const SPORT_ALIASES: Record<string, CanonicalSport> = {
  badminton: 'badminton', shuttle: 'badminton', shuttlecock: 'badminton',
  tennis: 'tennis', lawntennis: 'tennis',
  football: 'football', soccer: 'football', futsal: 'football', '5aside': 'football', fiveaside: 'football', turf: 'football',
  cricket: 'cricket', nets: 'cricket',
  basketball: 'basketball', hoops: 'basketball', bball: 'basketball',
  swimming: 'swimming', swim: 'swimming', pool: 'swimming', aquatics: 'swimming',
  tabletennis: 'tableTennis', tt: 'tableTennis', pingpong: 'tableTennis',
  squash: 'squash',
  gym: 'gym', fitness: 'gym', workout: 'gym', strength: 'gym',
  pickleball: 'pickleball', pickle: 'pickleball',
  bouldering: 'bouldering', climbing: 'bouldering', climb: 'bouldering',
  running: 'running', run: 'running', marathon: 'running', jogging: 'running', track: 'running',
};

function normalize(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** First tag (in order) that resolves to a canonical sport, else null. */
export function matchSport(tags: string[] | undefined): CanonicalSport | null {
  for (const tag of tags ?? []) {
    const key = SPORT_ALIASES[normalize(tag)];
    if (key) return key;
  }
  return null;
}

export type ResolvedImage =
  | { kind: 'photo'; src: string; sport?: CanonicalSport }
  | { kind: 'motif' };

export interface ResolveImageInput {
  /** Future uploaded photo (backend, deferred). Highest priority when present. */
  imageUrl?: string | null;
  tags?: string[];
}

/** Resolution order: uploaded photo → tag-matched sport photo → motif. */
export function resolveImage(input: ResolveImageInput): ResolvedImage {
  const sport = matchSport(input.tags);
  if (input.imageUrl) {
    return sport ? { kind: 'photo', src: input.imageUrl, sport } : { kind: 'photo', src: input.imageUrl };
  }
  if (sport) return { kind: 'photo', src: SPORT_IMAGES[sport], sport };
  return { kind: 'motif' };
}
