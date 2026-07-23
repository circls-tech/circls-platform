/**
 * Offline gazetteer for the stub geocoder — approximate coordinates for the
 * major cities of the two countries the product currently serves (India, USA),
 * plus a country centroid fallback. This is deliberately coarse: it exists so
 * the sandbox + tests can turn a partner-entered "City, Country" into a
 * lat/lng WITHOUT any network call, which is enough to power the consumer
 * "nearest city" / country auto-detect. Prod uses the Nominatim provider for
 * precise, arbitrary-address resolution (see index.ts).
 *
 * Coordinates are city-centre approximations (4 dp ≈ 11 m is meaningless here;
 * we only need the right city/country bucket). Keys are lowercased city names.
 */
import type { GeoPoint, ReversePlace } from './index.js';

/** Canonical country buckets. Values must match the partner Country dropdown. */
export type CountryKey = 'India' | 'USA';

/** Map loose country spellings/codes to a canonical bucket, or null if unknown. */
export function normalizeCountry(raw: string | null | undefined): CountryKey | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (['india', 'in', 'ind', 'bharat'].includes(s)) return 'India';
  if (['usa', 'us', 'u.s.', 'u.s.a.', 'united states', 'united states of america', 'america'].includes(s))
    return 'USA';
  return null;
}

/** Geographic centroid of each country — the fallback when the city is unknown. */
export const COUNTRY_CENTROID: Record<CountryKey, GeoPoint> = {
  India: { lat: 22.9734, lng: 78.6569 },
  USA: { lat: 39.8283, lng: -98.5795 },
};

/** City aliases → canonical gazetteer key (both lowercased). */
const CITY_ALIASES: Record<string, string> = {
  bangalore: 'bengaluru',
  bombay: 'mumbai',
  'new delhi': 'delhi',
  gurgaon: 'gurugram',
  calcutta: 'kolkata',
  madras: 'chennai',
  mysore: 'mysuru',
  'nyc': 'new york',
  'new york city': 'new york',
  'san fran': 'san francisco',
  sf: 'san francisco',
  'washington dc': 'washington',
  'd.c.': 'washington',
};

/** Per-country city → coordinates. Lowercased city keys. */
const CITIES: Record<CountryKey, Record<string, GeoPoint>> = {
  India: {
    bengaluru: { lat: 12.9716, lng: 77.5946 },
    mumbai: { lat: 19.076, lng: 72.8777 },
    delhi: { lat: 28.6139, lng: 77.209 },
    hyderabad: { lat: 17.385, lng: 78.4867 },
    chennai: { lat: 13.0827, lng: 80.2707 },
    kolkata: { lat: 22.5726, lng: 88.3639 },
    pune: { lat: 18.5204, lng: 73.8567 },
    ahmedabad: { lat: 23.0225, lng: 72.5714 },
    jaipur: { lat: 26.9124, lng: 75.7873 },
    surat: { lat: 21.1702, lng: 72.8311 },
    gurugram: { lat: 28.4595, lng: 77.0266 },
    noida: { lat: 28.5355, lng: 77.391 },
    chandigarh: { lat: 30.7333, lng: 76.7794 },
    kochi: { lat: 9.9312, lng: 76.2673 },
    panaji: { lat: 15.4909, lng: 73.8278 },
    lucknow: { lat: 26.8467, lng: 80.9462 },
    indore: { lat: 22.7196, lng: 75.8577 },
    nagpur: { lat: 21.1458, lng: 79.0882 },
    coimbatore: { lat: 11.0168, lng: 76.9558 },
    mysuru: { lat: 12.2958, lng: 76.6394 },
  },
  USA: {
    'new york': { lat: 40.7128, lng: -74.006 },
    'los angeles': { lat: 34.0522, lng: -118.2437 },
    chicago: { lat: 41.8781, lng: -87.6298 },
    houston: { lat: 29.7604, lng: -95.3698 },
    phoenix: { lat: 33.4484, lng: -112.074 },
    philadelphia: { lat: 39.9526, lng: -75.1652 },
    'san antonio': { lat: 29.4241, lng: -98.4936 },
    'san diego': { lat: 32.7157, lng: -117.1611 },
    dallas: { lat: 32.7767, lng: -96.797 },
    'san jose': { lat: 37.3382, lng: -121.8863 },
    austin: { lat: 30.2672, lng: -97.7431 },
    'san francisco': { lat: 37.7749, lng: -122.4194 },
    seattle: { lat: 47.6062, lng: -122.3321 },
    boston: { lat: 42.3601, lng: -71.0589 },
    denver: { lat: 39.7392, lng: -104.9903 },
    atlanta: { lat: 33.749, lng: -84.388 },
    miami: { lat: 25.7617, lng: -80.1918 },
    washington: { lat: 38.9072, lng: -77.0369 },
  },
};

/** A single gazetteer autocomplete hit. */
export interface GazetteerHit {
  city: string;
  country: CountryKey;
  lat: number;
  lng: number;
}

const titleCase = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Prefix/substring search over the gazetteer's cities — the offline stand-in for
 * a real autocomplete provider (used in the sandbox + tests). Optionally scoped
 * to one country; prefix matches rank above substring matches.
 */
export function searchGazetteer(
  query: string,
  country?: string | null,
  limit = 5,
): GazetteerHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scoped = normalizeCountry(country ?? null);
  const buckets: CountryKey[] = scoped ? [scoped] : (['India', 'USA'] as CountryKey[]);

  const hits: GazetteerHit[] = [];
  for (const ck of buckets) {
    for (const [city, pt] of Object.entries(CITIES[ck])) {
      if (city.includes(q)) hits.push({ city: titleCase(city), country: ck, lat: pt.lat, lng: pt.lng });
    }
  }
  hits.sort((a, b) => {
    const ap = a.city.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = b.city.toLowerCase().startsWith(q) ? 0 : 1;
    return ap - bp || a.city.localeCompare(b.city);
  });
  return hits.slice(0, limit);
}

/**
 * The canonical display spelling for a typed city — alias- and case-folded
 * against the gazetteer ("bangalore", "Bombay", "nyc" → "Bengaluru", "Mumbai",
 * "New York"). Scoped to `country` when it's recognised, else searched across
 * all served countries. Returns null when the city isn't known at all, so
 * callers keep whatever the partner typed (never destructive).
 */
export function canonicalizeCity(
  city: string | null | undefined,
  country?: string | null,
): string | null {
  if (!city || !city.trim()) return null;
  const raw = city.trim().toLowerCase();
  const key = CITY_ALIASES[raw] ?? raw;
  const scoped = normalizeCountry(country ?? null);
  const buckets: CountryKey[] = scoped ? [scoped] : (['India', 'USA'] as CountryKey[]);
  for (const ck of buckets) {
    if (CITIES[ck][key]) return titleCase(key);
  }
  return null;
}

/** Levenshtein distance — small inputs only (city names). */
function editDistance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/**
 * "Did you mean" for a typed city. Returns the canonical spelling when the
 * input is an alias/case variant of a known city, or the nearest known city
 * (or alias) within a small edit distance — "Banagalore" → "Bengaluru". Null
 * when the input is empty, too short, already canonical, or not close to
 * anything known. Scoped to `country` when recognised.
 */
export function suggestCity(
  city: string | null | undefined,
  country?: string | null,
): string | null {
  if (!city || city.trim().length < 3) return null;
  const raw = city.trim().toLowerCase();
  const canonical = canonicalizeCity(raw, country);
  if (canonical) return canonical.toLowerCase() === raw ? null : canonical;

  const scoped = normalizeCountry(country ?? null);
  const buckets: CountryKey[] = scoped ? [scoped] : (['India', 'USA'] as CountryKey[]);
  // Typos this close to a known name (or its alias) are near-certainly it.
  const maxDist = raw.length <= 5 ? 1 : 2;
  let best: { key: string; dist: number } | null = null;
  const consider = (candidate: string, key: string) => {
    if (Math.abs(candidate.length - raw.length) > maxDist) return;
    const dist = editDistance(raw, candidate);
    if (dist <= maxDist && (!best || dist < best.dist)) best = { key, dist };
  };
  for (const ck of buckets) {
    for (const key of Object.keys(CITIES[ck])) consider(key, key);
    for (const [alias, key] of Object.entries(CITY_ALIASES)) {
      if (CITIES[ck][key]) consider(alias, key);
    }
  }
  return best ? titleCase((best as { key: string }).key) : null;
}

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in km — local helper for the nearest-city reverse lookup. */
function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A point is named after the nearest gazetteer city only within this distance
 * of its centre — beyond it we can still bucket the country but claiming the
 * city name would mislabel rural/in-between users.
 */
const REVERSE_CITY_KM = 120;

/**
 * Nearest-city reverse lookup — the stub geocoder's `reverse()`. The city name
 * is included only within REVERSE_CITY_KM; the country comes from the nearest
 * listed city regardless (coarse, but the gazetteer only spans served
 * countries, so the bucket is right whenever the user is in one).
 */
export function reverseGazetteer(point: GeoPoint): ReversePlace | null {
  let best: { city: string; country: CountryKey; dist: number } | null = null;
  for (const ck of ['India', 'USA'] as CountryKey[]) {
    for (const [city, pt] of Object.entries(CITIES[ck])) {
      const dist = haversineKm(point, pt);
      if (!best || dist < best.dist) best = { city: titleCase(city), country: ck, dist };
    }
  }
  if (!best) return null;
  const hit = best as { city: string; country: CountryKey; dist: number };
  return { city: hit.dist <= REVERSE_CITY_KM ? hit.city : null, country: hit.country };
}

/**
 * Resolve a city (within a known country) to coordinates using the gazetteer.
 * Falls back to the country centroid when the city is unknown but the country
 * is recognised. Returns null when the country itself is unrecognised.
 */
export function lookupGazetteer(
  city: string | null | undefined,
  country: string | null | undefined,
): GeoPoint | null {
  const countryKey = normalizeCountry(country);
  if (!countryKey) return null;

  if (city && city.trim()) {
    const raw = city.trim().toLowerCase();
    const key = CITY_ALIASES[raw] ?? raw;
    const hit = CITIES[countryKey][key];
    if (hit) return hit;
  }
  // Known country, unknown/absent city → country centroid so at least the
  // country auto-detect resolves correctly.
  return COUNTRY_CENTROID[countryKey];
}
