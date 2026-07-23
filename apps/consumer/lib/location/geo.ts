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
  // Prefer the structured address columns (what the partner form writes) and
  // fall back to the freeform address_json. Older venues have their city/country
  // only in `address` with a null `addressJson`, so reading addressJson alone
  // would drop them from the location picker ("No cities available yet").
  return {
    city: v.address.city ?? cityOf(v.addressJson),
    country: v.address.country ?? countryOf(v.addressJson),
    lat: v.lat,
    lng: v.lng,
  };
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
  /**
   * The user's device position, present only when the selection came from
   * geolocation ("Use my current location"). Manual city picks clear it —
   * picking a city means "show me that whole city", not "near me".
   */
  coords?: Coords | null;
}

/**
 * Whether a place with this country falls in the selected country. A null
 * selection matches everything; a place with no country is shown everywhere
 * (lenient — we never hide untagged data).
 */
export function matchesCountry(country: string | null, selected: string | null): boolean {
  if (!selected) return true;
  return country == null || sameCountry(country, selected);
}

/** `matchesCountry` for a place whose country lives in freeform address JSON. */
export function inCountry(
  addressJson: Record<string, unknown> | null,
  country: string | null,
): boolean {
  return matchesCountry(countryOf(addressJson), country);
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
 * A venue's city: the structured address column (what the partner form writes),
 * falling back to freeform address_json for older venues.
 */
export function venueCity(v: PublicVenue): string | null {
  return v.address.city ?? cityOf(v.addressJson);
}

/** A venue's country, structured column first (same fallback as `venueCity`). */
export function venueCountry(v: PublicVenue): string | null {
  return v.address.country ?? countryOf(v.addressJson);
}

/**
 * Venues for the selected area — country boundary first, then:
 * - a selected CITY is a HARD filter: only that city's venues return, and an
 *   empty result means the caller shows its empty state (no country fallback).
 *   Venues without a city on file are hidden (they can't prove they're local).
 * - shared COORDS without a city (the user is outside every served city, e.g.
 *   Delhi with only Nagpur served): geolocated venues must lie within
 *   NEARBY_RADIUS_KM, mirroring events. Ungeocoded venues fall back to the
 *   lenient country match — we never hide untagged data.
 * - country-only or empty selections behave as before.
 * The input array is not mutated. Pass the already-search-filtered API rows.
 */
export function venuesForArea(venues: PublicVenue[], sel: AreaSelection): PublicVenue[] {
  const inSel = venues.filter((v) => matchesCountry(venueCountry(v), sel.country));
  if (sel.city) return inSel.filter((v) => sameCity(venueCity(v), sel.city));
  const coords = sel.coords ?? null;
  if (coords) {
    return inSel.filter(
      (v) =>
        typeof v.lat !== 'number' ||
        typeof v.lng !== 'number' ||
        haversineKm(coords, { lat: v.lat, lng: v.lng }) <= NEARBY_RADIUS_KM,
    );
  }
  return inSel;
}

/**
 * Whether a membership is visible for the selected area. Country is the market
 * boundary (a plan is priced and honoured in one country). A venue-scoped plan
 * carries its venue's city + coordinates: a selected city HARD-filters by
 * city; shared coords without a city apply the NEARBY_RADIUS_KM radius.
 * Tenant-wide plans (and venue plans with no location on file) stay visible
 * across the country — a brand pass isn't city-bound.
 */
export function membershipInArea(
  m: { city: string | null; country: string | null; lat?: number | null; lng?: number | null },
  sel: AreaSelection,
): boolean {
  if (!matchesCountry(m.country, sel.country)) return false;
  if (sel.city) return m.city == null || sameCity(m.city, sel.city);
  const coords = sel.coords ?? null;
  if (coords && typeof m.lat === 'number' && typeof m.lng === 'number') {
    return haversineKm(coords, { lat: m.lat, lng: m.lng }) <= NEARBY_RADIUS_KM;
  }
  return true;
}

/** Events, venues, and venue-scoped plans are visible within this distance of
 *  the user's shared location. Internal — the UI never shows the number. */
export const NEARBY_RADIUS_KM = 50;

/**
 * Whether an event is visible for the given selection. When the user shared
 * their device location (`sel.coords`), a geolocated event must lie within
 * `radiusKm` of them — country is irrelevant, distance is the boundary. Events
 * without coordinates can't be distance-checked and fall back to the lenient
 * country match (we never hide untagged data). Without coords — a manual city
 * pick, or no selection at all — this is the existing country check, so picking
 * a city still shows that whole market's events.
 */
export function eventInRange(
  e: { locLat: number | null; locLng: number | null; locAddressJson: Record<string, unknown> | null },
  sel: AreaSelection,
  radiusKm: number = NEARBY_RADIUS_KM,
): boolean {
  const coords = sel.coords ?? null;
  if (coords && typeof e.locLat === 'number' && typeof e.locLng === 'number') {
    return haversineKm(coords, { lat: e.locLat, lng: e.locLng }) <= radiusKm;
  }
  return inCountry(e.locAddressJson, sel.country);
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
