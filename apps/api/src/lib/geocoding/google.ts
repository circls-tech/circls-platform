/**
 * Google Maps Platform provider for the geocoding port (`GEOCODER_PROVIDER=google`).
 *
 *   - `search`  → Places API (New) Autocomplete. Returns predictions only — a
 *                 label and a place ID, no address parts or coordinates.
 *   - `resolve` → Place Details (New) for a picked prediction, asking only for
 *                 Essentials-tier fields (address parts + location). Sent with
 *                 the search's session token, it ends the autocomplete session,
 *                 which caps that session's billed search requests at 12.
 *   - `geocode` / `reverse` → Geocoding API.
 *
 * Google's terms (Maps Service Specific Terms §6.3, §14.3) let us keep the
 * coordinates these return for at most 30 days, but place IDs indefinitely, so
 * a stored Google coordinate always travels with its place ID and
 * services/coords_refresh_service.ts re-fetches it before the 30 days run out.
 * The same terms forbid showing these results on a non-Google map.
 */
import { logger } from '../logger.js';
import { type CountryKey, normalizeCountry } from './gazetteer.js';
import type {
  AddressSuggestion,
  GeocodeQuery,
  GeoPoint,
  Geocoder,
  ReversePlace,
  SearchOptions,
} from './index.js';

const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

/** Region codes for the served countries, as both APIs take them. */
const REGION_CODE: Record<CountryKey, string> = { India: 'in', USA: 'us' };

/** Place Details fields we read. All are Essentials-tier; asking for any
 *  other (displayName, say) bills the whole call at the Pro rate. */
const DETAILS_FIELD_MASK = 'id,formattedAddress,addressComponents,location';

/** Give up on a Google call after this long — a save never waits longer. */
const TIMEOUT_MS = 5000;

/** One address component, in the shape both APIs share once normalised. */
export interface AddressComponent {
  long: string;
  short: string;
  types: string[];
}

function component(components: AddressComponent[], ...types: string[]): AddressComponent | undefined {
  for (const type of types) {
    const hit = components.find((c) => c.types.includes(type));
    if (hit) return hit;
  }
  return undefined;
}

/** The town a set of components is in. NYC addresses carry the borough as
 *  sublocality_level_1 and no locality; Indian ones nearly always have one. */
function cityOf(components: AddressComponent[]): string | null {
  return (
    component(components, 'locality', 'postal_town', 'sublocality_level_1', 'administrative_area_level_2')
      ?.long ?? null
  );
}

/**
 * Fold Google address components into the venue form's fields. `line1` is the
 * building and street, followed by the neighbourhood — Indian addresses often
 * have no street number, and the area ("Koramangala") is what locates them.
 */
export function toAddressParts(
  components: AddressComponent[],
): Pick<AddressSuggestion, 'line1' | 'city' | 'state' | 'postalCode' | 'country'> {
  const city = cityOf(components);
  const street = [component(components, 'street_number')?.long, component(components, 'route')?.long]
    .filter(Boolean)
    .join(' ');
  const line1Parts = [
    component(components, 'subpremise')?.long,
    component(components, 'premise')?.long,
    street,
    component(components, 'sublocality_level_3')?.long,
    component(components, 'sublocality_level_2')?.long,
    component(components, 'sublocality_level_1')?.long,
    component(components, 'neighborhood')?.long,
  ].filter((p): p is string => Boolean(p) && p !== city);
  return {
    line1: [...new Set(line1Parts)].join(', ') || null,
    city,
    state: component(components, 'administrative_area_level_1')?.long ?? null,
    postalCode: component(components, 'postal_code')?.long ?? null,
    country: normalizeCountry(component(components, 'country')?.short),
  };
}

/** Free-text form of a structured address, for the Geocoding API. */
function addressText(q: GeocodeQuery): string {
  return [q.line1, q.city, q.state, q.postalCode, q.country].filter((s) => s && s.trim()).join(', ');
}

interface PlacesAutocompleteResponse {
  suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string } } }[];
}

interface PlaceDetailsResponse {
  id?: string;
  formattedAddress?: string;
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
  location?: { latitude?: number; longitude?: number };
}

interface GeocodingResponse {
  status?: string;
  results?: {
    place_id?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
    address_components?: { long_name?: string; short_name?: string; types?: string[] }[];
  }[];
}

export class GoogleGeocoder implements Geocoder {
  readonly mode = 'google' as const;
  /** @param countries Where to suggest and geocode (GOOGLE_MAPS_COUNTRIES). */
  constructor(
    private readonly apiKey: string,
    private readonly countries: readonly CountryKey[] = Object.keys(REGION_CODE) as CountryKey[],
  ) {}

  /** Places (New) call. Null on any failure — geocoding is best-effort. */
  private async places<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown; fieldMask?: string }): Promise<T | null> {
    try {
      const res = await fetch(`${PLACES_BASE_URL}/${path}`, {
        method: init.method,
        headers: {
          'X-Goog-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
          ...(init.fieldMask ? { 'X-Goog-FieldMask': init.fieldMask } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        // A place that no longer exists is an expected 404, not an alarm.
        if (res.status !== 404) logger.warn({ status: res.status, path: path.split('/')[0] }, 'geocode_google_places_error');
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      logger.warn({ err }, 'geocode_google_places_failed');
      return null;
    }
  }

  /** Geocoding API call (it takes the key as a query parameter, so the URL is never logged). */
  private async geocoding(params: URLSearchParams): Promise<NonNullable<GeocodingResponse['results']>[number] | null> {
    params.set('key', this.apiKey);
    params.set('language', 'en');
    try {
      const res = await fetch(`${GEOCODE_URL}?${params.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const json = (await res.json().catch(() => ({}))) as GeocodingResponse;
      if (json.status === 'OK') return json.results?.[0] ?? null;
      if (json.status !== 'ZERO_RESULTS') logger.warn({ status: json.status ?? res.status }, 'geocode_google_error');
      return null;
    } catch (err) {
      logger.warn({ err }, 'geocode_google_failed');
      return null;
    }
  }

  async geocode(query: GeocodeQuery): Promise<GeoPoint | null> {
    const address = addressText(query);
    if (!address) return null;
    const params = new URLSearchParams({ address });
    const wanted = normalizeCountry(query.country ?? null);
    // An address in a country we don't geocode in costs no request.
    if (wanted && !this.countries.includes(wanted)) return null;
    // The Geocoding API filters by one country at a time, so an address with
    // no country is held to ours only when there is just one.
    const only = wanted ?? (this.countries.length === 1 ? this.countries[0] : null);
    if (only) params.set('components', `country:${REGION_CODE[only]}`);
    const hit = await this.geocoding(params);
    const loc = hit?.geometry?.location;
    if (typeof loc?.lat !== 'number' || typeof loc?.lng !== 'number') return null;
    return { lat: loc.lat, lng: loc.lng, placeId: hit?.place_id ?? null };
  }

  async search(query: string, opts: SearchOptions = {}): Promise<AddressSuggestion[]> {
    const input = query.trim();
    if (!input) return [];
    const scoped = normalizeCountry(opts.country ?? null);
    // A form scoped to a country we don't suggest in gets nothing, and costs
    // no request; the partner can still drop the pin by hand.
    if (scoped && !this.countries.includes(scoped)) return [];
    const json = await this.places<PlacesAutocompleteResponse>('places:autocomplete', {
      method: 'POST',
      body: {
        input,
        includedRegionCodes: (scoped ? [scoped] : this.countries).map((c) => REGION_CODE[c]),
        languageCode: 'en',
        ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
      },
    });
    const out: AddressSuggestion[] = [];
    for (const s of json?.suggestions ?? []) {
      const placeId = s.placePrediction?.placeId;
      const label = s.placePrediction?.text?.text;
      if (!placeId || !label) continue;
      out.push({
        label,
        placeId,
        line1: null,
        city: null,
        state: null,
        postalCode: null,
        country: null,
        lat: null,
        lng: null,
      });
      if (out.length >= (opts.limit ?? 5)) break;
    }
    return out;
  }

  async resolve(placeId: string, sessionToken?: string | null): Promise<AddressSuggestion | null> {
    const params = new URLSearchParams({ languageCode: 'en' });
    if (sessionToken) params.set('sessionToken', sessionToken);
    const json = await this.places<PlaceDetailsResponse>(
      `places/${encodeURIComponent(placeId)}?${params.toString()}`,
      { method: 'GET', fieldMask: DETAILS_FIELD_MASK },
    );
    const lat = json?.location?.latitude;
    const lng = json?.location?.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    const parts = toAddressParts(
      (json?.addressComponents ?? []).map((c) => ({
        long: c.longText ?? '',
        short: c.shortText ?? '',
        types: c.types ?? [],
      })),
    );
    const label =
      json?.formattedAddress ??
      [parts.line1, parts.city, parts.state, parts.country].filter(Boolean).join(', ');
    return { label, placeId: json?.id ?? placeId, ...parts, lat, lng };
  }

  async reverse(point: GeoPoint): Promise<ReversePlace | null> {
    const hit = await this.geocoding(new URLSearchParams({ latlng: `${point.lat},${point.lng}` }));
    if (!hit) return null;
    const components = (hit.address_components ?? []).map((c) => ({
      long: c.long_name ?? '',
      short: c.short_name ?? '',
      types: c.types ?? [],
    }));
    const city = cityOf(components);
    const countryComponent = component(components, 'country');
    const country = normalizeCountry(countryComponent?.short) ?? countryComponent?.long ?? null;
    if (!city && !country) return null;
    return { city, country };
  }
}
