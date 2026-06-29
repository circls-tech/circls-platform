import type { PublicEventWithVenue, PublicVenue } from '@/lib/api/types';

export interface Coords {
  lat: number;
  lng: number;
}

/** A place with optional city/country/coordinates — the input to `derivePlaces`. */
export interface Locatable {
  city: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
}

/** A selectable city, derived from the venues and events located in it. */
export interface CityOption {
  /** Display name (first spelling seen for this city). */
  city: string;
  /** Country this city belongs to (first non-null seen), or null if unknown. */
  country: string | null;
  /** How many venues/events are in this city. */
  count: number;
  /** Centroid of the city's geolocated places; meaningless unless `hasCoords`. */
  lat: number;
  lng: number;
  /** True when at least one place in the city had coordinates. */
  hasCoords: boolean;
}

/** Read a trimmed string field from freeform address JSON, or null. */
function strField(addressJson: Record<string, unknown> | null, key: string): string | null {
  const v = addressJson?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Read a trimmed city string from a freeform address JSON, or null. */
export function cityOf(addressJson: Record<string, unknown> | null): string | null {
  return strField(addressJson, 'city');
}

/** Read a trimmed country string from a freeform address JSON, or null. */
export function countryOf(addressJson: Record<string, unknown> | null): string | null {
  return strField(addressJson, 'country');
}

/** Case-insensitive country equality (trim-tolerant). */
export function sameCountry(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Case-insensitive city equality (trim-tolerant). Null on either side is false. */
export function sameCity(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function venueToLocatable(v: PublicVenue): Locatable {
  return { city: cityOf(v.addressJson), country: countryOf(v.addressJson), lat: v.lat, lng: v.lng };
}

export function eventToLocatable(e: PublicEventWithVenue): Locatable {
  return {
    city: cityOf(e.locAddressJson),
    country: countryOf(e.locAddressJson),
    lat: e.locLat,
    lng: e.locLng,
  };
}

/**
 * Distinct cities across the given places, each with the centroid of its
 * geolocated members, the country it belongs to, and a member count. Cities are
 * folded case-insensitively but keep the first spelling seen. Sorted by count
 * (desc), then name (asc). Places without a city are ignored.
 */
export function derivePlaces(items: Locatable[]): CityOption[] {
  const map = new Map<
    string,
    { name: string; country: string | null; latSum: number; lngSum: number; geo: number; count: number }
  >();
  for (const it of items) {
    if (!it.city) continue;
    const key = it.city.toLowerCase();
    const e =
      map.get(key) ?? { name: it.city, country: null, latSum: 0, lngSum: 0, geo: 0, count: 0 };
    e.count += 1;
    if (!e.country && it.country) e.country = it.country;
    if (typeof it.lat === 'number' && typeof it.lng === 'number') {
      e.latSum += it.lat;
      e.lngSum += it.lng;
      e.geo += 1;
    }
    map.set(key, e);
  }
  return [...map.values()]
    .map((e) => ({
      city: e.name,
      country: e.country,
      count: e.count,
      lat: e.geo ? e.latSum / e.geo : 0,
      lng: e.geo ? e.lngSum / e.geo : 0,
      hasCoords: e.geo > 0,
    }))
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));
}

/** The country of the named city in `cities`, or null if unknown / not found. */
export function countryForCity(cities: CityOption[], city: string | null): string | null {
  if (!city) return null;
  const key = city.toLowerCase();
  return cities.find((c) => c.city.toLowerCase() === key)?.country ?? null;
}

/** The active location selection: a city (for venues) and/or a country (for events). */
export interface AreaSelection {
  city: string | null;
  country: string | null;
}

/**
 * Whether a place with this address falls in the selected country. A null
 * selection matches everything; a place with no country is shown everywhere
 * (lenient — we never hide untagged data).
 */
export function inCountry(
  addressJson: Record<string, unknown> | null,
  country: string | null,
): boolean {
  if (!country) return true;
  const c = countryOf(addressJson);
  return c == null || sameCountry(c, country);
}

/** Whether a venue's address falls in the selected area (country, then city). */
export function inArea(
  addressJson: Record<string, unknown> | null,
  sel: AreaSelection,
): boolean {
  if (!inCountry(addressJson, sel.country)) return false;
  if (sel.city && cityOf(addressJson) !== sel.city) return false;
  return true;
}

/** Whether a venue's city matches the selected city (a soft "near you" signal). */
export function venueInCity(
  addressJson: Record<string, unknown> | null,
  city: string | null,
): boolean {
  if (!city) return false;
  return sameCity(cityOf(addressJson), city);
}

/**
 * In-country venues for the selected area, with the user's city used as a SOFT
 * signal — same-city venues are sorted first (a "near you" hint), but no venue
 * is dropped for being in another city of the same country. This keeps a country
 * with venues from ever rendering an empty list just because the user's exact
 * city has none. Country is still a hard boundary (USA users never see India
 * venues); untagged venues stay visible (lenient, per `inCountry`). The input
 * array is not mutated. Pass the already-search-filtered rows from the API.
 */
export function venuesForArea(venues: PublicVenue[], sel: AreaSelection): PublicVenue[] {
  const inSel = venues.filter((v) => inCountry(v.addressJson, sel.country));
  if (!sel.city) return inSel;
  // Stable partition: same-city venues first, everything else after, each in
  // its original (API) order. Array.prototype.sort is stable in modern engines.
  return [...inSel].sort(
    (a, b) =>
      Number(venueInCity(b.addressJson, sel.city)) -
      Number(venueInCity(a.addressJson, sel.city)),
  );
}

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in kilometres. */
export function haversineKm(a: Coords, b: Coords): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The geolocated city closest to `coords`, or null if no city has coordinates. */
export function nearestCity(
  coords: Coords,
  cities: CityOption[],
): { city: CityOption; distanceKm: number } | null {
  let best: { city: CityOption; distanceKm: number } | null = null;
  for (const c of cities) {
    if (!c.hasCoords) continue;
    const distanceKm = haversineKm(coords, c);
    if (!best || distanceKm < best.distanceKm) best = { city: c, distanceKm };
  }
  return best;
}
