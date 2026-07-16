/**
 * Countries the product serves. Must stay in sync with the API geocoder's
 * recognised countries (apps/api/src/lib/geocoding/gazetteer.ts) — an unlisted
 * country won't resolve to a map location.
 */
export const SERVED_COUNTRIES = ['India', 'USA'] as const;
