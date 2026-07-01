/**
 * Geocoding port — turns a venue's postal address into a lat/lng so organisers
 * never have to hand-enter coordinates. Two providers behind one interface,
 * selected by `GEOCODER_PROVIDER` (mirrors the notifications provider pattern):
 *
 *   - `stub`      — resolves against a built-in IN/US gazetteer (offline). The
 *                   default; used in the sandbox + tests. Unknown city within a
 *                   known country falls back to the country centroid.
 *   - `nominatim` — OpenStreetMap Nominatim HTTP geocoder for prod. Free/keyless;
 *                   ODbL permits storing the returned coordinates. Subject to
 *                   Nominatim's usage policy (≤1 req/s, valid User-Agent) — fine
 *                   for infrequent venue saves.
 *
 * Geocoding is best-effort: callers treat a null result as "leave coordinates
 * as they are" and never fail a save because geocoding failed.
 */
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { lookupGazetteer } from './gazetteer.js';

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** The address parts we geocode from. All optional; more parts = better hits. */
export interface GeocodeQuery {
  line1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface Geocoder {
  readonly mode: 'stub' | 'nominatim';
  /** Resolve an address to coordinates, or null if it can't be resolved. */
  geocode(query: GeocodeQuery): Promise<GeoPoint | null>;
}

/** True when a query carries enough signal to bother geocoding at all. */
export function hasGeocodableAddress(q: GeocodeQuery): boolean {
  return Boolean((q.city && q.city.trim()) || (q.country && q.country.trim()));
}

class StubGeocoder implements Geocoder {
  readonly mode = 'stub' as const;
  async geocode(query: GeocodeQuery): Promise<GeoPoint | null> {
    return lookupGazetteer(query.city, query.country);
  }
}

class NominatimGeocoder implements Geocoder {
  readonly mode = 'nominatim' as const;
  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
  ) {}

  async geocode(query: GeocodeQuery): Promise<GeoPoint | null> {
    // Structured query — Nominatim ranks these better than a free-text string.
    const params = new URLSearchParams({ format: 'jsonv2', limit: '1' });
    if (query.city?.trim()) params.set('city', query.city.trim());
    if (query.state?.trim()) params.set('state', query.state.trim());
    if (query.postalCode?.trim()) params.set('postalcode', query.postalCode.trim());
    if (query.country?.trim()) params.set('country', query.country.trim());
    // Fall back to a free-text street query when no structured city is given.
    if (!query.city?.trim() && query.line1?.trim()) {
      params.delete('city');
      params.set('q', [query.line1, query.state, query.country].filter(Boolean).join(', '));
    }

    const url = `${this.baseUrl.replace(/\/$/, '')}/search?${params.toString()}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' } });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'geocode_nominatim_http_error');
        return null;
      }
      const json = (await res.json().catch(() => [])) as Array<{ lat?: string; lon?: string }>;
      const first = json[0];
      if (!first?.lat || !first?.lon) return null;
      const lat = Number(first.lat);
      const lng = Number(first.lon);
      if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
      return { lat, lng };
    } catch (err) {
      logger.warn({ err }, 'geocode_nominatim_failed');
      return null;
    }
  }
}

let cached: Geocoder | undefined;

export function getGeocoder(): Geocoder {
  if (cached) return cached;
  cached =
    env.GEOCODER_PROVIDER === 'nominatim'
      ? new NominatimGeocoder(env.GEOCODER_BASE_URL, env.GEOCODER_USER_AGENT)
      : new StubGeocoder();
  return cached;
}

/** Boot-time introspection: which geocoder resolved. Logged once at startup. */
export function geocoderMode(): string {
  return getGeocoder().mode;
}

/** Test-only reset. */
export function __resetGeocoderForTesting(): void {
  cached = undefined;
}
