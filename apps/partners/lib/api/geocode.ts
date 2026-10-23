import { apiFetch } from './client';

/**
 * One address autocomplete suggestion returned by the API's geocode search.
 *
 * With the Google provider a suggestion is only a prediction — `placeId` set,
 * address parts and coordinates null — until {@link resolvePlace} fills it in.
 */
export interface AddressSuggestion {
  label: string;
  /** The Google place behind the suggestion; null from the free providers. */
  placeId: string | null;
  line1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
}

/** Which geocoder answered. Google results must be credited to Google Maps. */
export type GeocoderProvider = 'stub' | 'photon' | 'google';

/**
 * Query the venue address autocomplete. `country` (optional) restricts results;
 * `session` groups one search's keystrokes into one billed Google session.
 * Returns no suggestions for short/empty queries without hitting the network.
 */
export async function searchAddress(
  q: string,
  country?: string | null,
  session?: string | null,
): Promise<{ suggestions: AddressSuggestion[]; provider: GeocoderProvider | null }> {
  const query = q.trim();
  if (query.length < 2) return { suggestions: [], provider: null };
  const params = new URLSearchParams({ q: query });
  if (country) params.set('country', country);
  if (session) params.set('session', session);
  const res = await apiFetch<{ suggestions: AddressSuggestion[]; provider?: GeocoderProvider }>(
    `/v1/venues/geocode/search?${params.toString()}`,
  );
  return { suggestions: res.suggestions, provider: res.provider ?? null };
}

/**
 * The full address and coordinates of a picked Google suggestion. Passing the
 * search's `session` ends that session (see {@link searchAddress}).
 */
export async function resolvePlace(placeId: string, session?: string | null): Promise<AddressSuggestion> {
  const params = new URLSearchParams();
  if (session) params.set('session', session);
  const res = await apiFetch<{ suggestion: AddressSuggestion }>(
    `/v1/venues/geocode/place/${encodeURIComponent(placeId)}?${params.toString()}`,
  );
  return res.suggestion;
}

/**
 * Where to centre the map for a typed city: a known city's centre, or null.
 * Offline on the server, so it costs nothing to follow the typing.
 */
export async function cityCenter(
  city: string,
  country?: string | null,
): Promise<{ lat: number; lng: number } | null> {
  const params = new URLSearchParams({ city });
  if (country) params.set('country', country);
  const res = await apiFetch<{ center: { lat: number; lng: number } | null }>(
    `/v1/venues/geocode/city-center?${params.toString()}`,
  );
  return res.center;
}

/**
 * "Did you mean" for a hand-typed city: the canonical spelling when the input
 * is an alias/typo of a known city ("Banagalore" → "Bengaluru"), or null when
 * it's already canonical or unrecognised. Returns null for short/empty input
 * without hitting the network.
 */
export async function suggestCity(city: string, country?: string | null): Promise<string | null> {
  const q = city.trim();
  if (q.length < 3) return null;
  const params = new URLSearchParams({ city: q });
  if (country) params.set('country', country);
  const res = await apiFetch<{ suggestion: string | null }>(
    `/v1/venues/geocode/suggest-city?${params.toString()}`,
  );
  return res.suggestion;
}
