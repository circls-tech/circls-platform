import { apiFetch } from './client';

/** One address autocomplete suggestion returned by the API's geocode search. */
export interface AddressSuggestion {
  label: string;
  line1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  lat: number;
  lng: number;
}

/**
 * Query the venue address autocomplete. `country` (optional) restricts results.
 * Returns [] for short/empty queries without hitting the network.
 */
export async function searchAddress(q: string, country?: string | null): Promise<AddressSuggestion[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  const params = new URLSearchParams({ q: query });
  if (country) params.set('country', country);
  const res = await apiFetch<{ suggestions: AddressSuggestion[] }>(
    `/v1/venues/geocode/search?${params.toString()}`,
  );
  return res.suggestions;
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
