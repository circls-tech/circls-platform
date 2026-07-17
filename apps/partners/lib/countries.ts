/**
 * Countries the product serves. Must stay in sync with the API geocoder's
 * recognised countries (apps/api/src/lib/geocoding/gazetteer.ts) — an unlisted
 * country won't resolve to a map location.
 */
export const SERVED_COUNTRIES = ['India', 'USA'] as const;

/**
 * Geographic centre of each served country — the map pin picker's starting
 * view before any city or pin narrows it down. Mirrors COUNTRY_CENTROID in the
 * API gazetteer (values are display defaults, not stored data).
 */
export const COUNTRY_CENTROIDS: Record<string, { lat: number; lng: number }> = {
  India: { lat: 22.9734, lng: 78.6569 },
  USA: { lat: 39.8283, lng: -98.5795 },
};
