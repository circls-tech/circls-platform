/**
 * Geocoding + address-search port — turns a venue's postal address into a
 * lat/lng (so organisers never hand-enter coordinates) and powers type-ahead
 * address autocomplete. Two providers behind one interface, selected by
 * `GEOCODER_PROVIDER` (mirrors the notifications provider pattern):
 *
 *   - `stub`   — resolves + searches against a built-in IN/US gazetteer
 *                (offline). The default; used in the sandbox + tests. Unknown
 *                city within a known country geocodes to the country centroid.
 *   - `photon` — OpenStreetMap Photon HTTP geocoder for prod. Free/keyless;
 *                ODbL permits storing the returned coordinates; built for
 *                autocomplete. Subject to OSM fair-use — fine for venue edits.
 *
 * Geocoding is best-effort: callers treat a null result as "leave coordinates
 * as they are" and never fail a save because geocoding failed.
 */
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { lookupGazetteer, normalizeCountry, searchGazetteer } from './gazetteer.js';

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

/** A single autocomplete suggestion — enough to fill the venue address form. */
export interface AddressSuggestion {
  /** Human-readable one-line label for the dropdown. */
  label: string;
  line1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** Canonical country ('India' | 'USA'), or null if unrecognised. */
  country: string | null;
  lat: number;
  lng: number;
}

export interface SearchOptions {
  /** Restrict suggestions to this country (canonical name); omit for all served countries. */
  country?: string | null;
  limit?: number;
}

export interface Geocoder {
  readonly mode: 'stub' | 'photon';
  /** Resolve an address to coordinates, or null if it can't be resolved. */
  geocode(query: GeocodeQuery): Promise<GeoPoint | null>;
  /** Type-ahead address suggestions for a partial query. */
  search(query: string, opts?: SearchOptions): Promise<AddressSuggestion[]>;
}

/** True when a query carries enough signal to bother geocoding at all. */
export function hasGeocodableAddress(q: GeocodeQuery): boolean {
  return Boolean((q.city && q.city.trim()) || (q.country && q.country.trim()));
}

/** Compose a Photon free-text query from structured address parts. */
function toQueryString(q: GeocodeQuery): string {
  return [q.line1, q.city, q.state, q.postalCode, q.country].filter((s) => s && s.trim()).join(', ');
}

class StubGeocoder implements Geocoder {
  readonly mode = 'stub' as const;

  async geocode(query: GeocodeQuery): Promise<GeoPoint | null> {
    return lookupGazetteer(query.city, query.country);
  }

  async search(query: string, opts: SearchOptions = {}): Promise<AddressSuggestion[]> {
    return searchGazetteer(query, opts.country, opts.limit ?? 5).map((h) => ({
      label: `${h.city}, ${h.country}`,
      line1: null,
      city: h.city,
      state: null,
      postalCode: null,
      country: h.country,
      lat: h.lat,
      lng: h.lng,
    }));
  }
}

/** A subset of a Photon GeoJSON feature — only the fields we consume. */
interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    street?: string;
    housenumber?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
    countrycode?: string;
  };
}

class PhotonGeocoder implements Geocoder {
  readonly mode = 'photon' as const;
  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
  ) {}

  private async request(params: URLSearchParams): Promise<PhotonFeature[]> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api?${params.toString()}`;
    const res = await fetch(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' } });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'geocode_photon_http_error');
      return [];
    }
    const json = (await res.json().catch(() => ({}))) as { features?: PhotonFeature[] };
    return json.features ?? [];
  }

  async geocode(query: GeocodeQuery): Promise<GeoPoint | null> {
    const q = toQueryString(query);
    if (!q) return null;
    const params = new URLSearchParams({ q, limit: '1', lang: 'en' });
    try {
      const features = await this.request(params);
      // Prefer a feature in the requested country when one was given.
      const wanted = normalizeCountry(query.country ?? null);
      const feat =
        (wanted && features.find((f) => normalizeCountry(f.properties?.countrycode) === wanted)) ||
        features[0];
      const coords = feat?.geometry?.coordinates;
      if (!coords) return null;
      const [lng, lat] = coords;
      if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
      return { lat, lng };
    } catch (err) {
      logger.warn({ err }, 'geocode_photon_failed');
      return null;
    }
  }

  async search(query: string, opts: SearchOptions = {}): Promise<AddressSuggestion[]> {
    const text = query.trim();
    if (!text) return [];
    const limit = opts.limit ?? 5;
    const scoped = normalizeCountry(opts.country ?? null);
    // Photon has no country param — over-fetch, then filter to served countries.
    const params = new URLSearchParams({ q: text, limit: String(limit * 3), lang: 'en' });
    try {
      const features = await this.request(params);
      const out: AddressSuggestion[] = [];
      for (const f of features) {
        const p = f.properties ?? {};
        const coords = f.geometry?.coordinates;
        if (!coords) continue;
        const country = normalizeCountry(p.countrycode ?? p.country ?? null);
        if (!country) continue; // outside the countries we serve
        if (scoped && country !== scoped) continue;
        const [lng, lat] = coords;
        const line1 = [p.housenumber, p.street ?? p.name].filter(Boolean).join(' ') || null;
        out.push({
          label: [p.name ?? p.street, p.city, p.state, country].filter(Boolean).join(', '),
          line1,
          city: p.city ?? null,
          state: p.state ?? null,
          postalCode: p.postcode ?? null,
          country,
          lat,
          lng,
        });
        if (out.length >= limit) break;
      }
      return out;
    } catch (err) {
      logger.warn({ err }, 'geocode_photon_search_failed');
      return [];
    }
  }
}

let cached: Geocoder | undefined;

export function getGeocoder(): Geocoder {
  if (cached) return cached;
  cached =
    env.GEOCODER_PROVIDER === 'photon'
      ? new PhotonGeocoder(env.GEOCODER_BASE_URL, env.GEOCODER_USER_AGENT)
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
