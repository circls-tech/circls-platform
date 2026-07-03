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
