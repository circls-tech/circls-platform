import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleGeocoder, toAddressParts } from './google.js';

/** Stub fetch with one canned JSON response; returns the mock to inspect calls. */
function respondWith(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL and init of the mock's only call. */
function onlyCall(fetchMock: ReturnType<typeof respondWith>): { url: URL; init: RequestInit } {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url: new URL(url), init };
}

afterEach(() => vi.unstubAllGlobals());

const geocoder = new GoogleGeocoder('test-key');

/** Place Details for a Bengaluru address with no street number, as Indian ones often are. */
const KORAMANGALA = {
  id: 'ChIJkoramangala',
  formattedAddress: '80 Feet Rd, Koramangala 4th Block, Bengaluru, Karnataka 560034, India',
  location: { latitude: 12.9352, longitude: 77.6245 },
  addressComponents: [
    { longText: '80 Feet Road', shortText: '80 Feet Rd', types: ['route'] },
    { longText: '4th Block', shortText: '4th Block', types: ['sublocality_level_2', 'sublocality', 'political'] },
    { longText: 'Koramangala', shortText: 'Koramangala', types: ['sublocality_level_1', 'sublocality', 'political'] },
    { longText: 'Bengaluru', shortText: 'Bengaluru', types: ['locality', 'political'] },
    { longText: 'Bangalore Urban', shortText: 'Bangalore Urban', types: ['administrative_area_level_2', 'political'] },
    { longText: 'Karnataka', shortText: 'KA', types: ['administrative_area_level_1', 'political'] },
    { longText: 'India', shortText: 'IN', types: ['country', 'political'] },
    { longText: '560034', shortText: '560034', types: ['postal_code'] },
  ],
};

describe('GoogleGeocoder.search', () => {
  it('returns unresolved predictions, limited to the served regions, under the session token', async () => {
    const fetchMock = respondWith({
      suggestions: [
        { placePrediction: { placeId: 'ChIJa', text: { text: 'Koramangala, Bengaluru, Karnataka, India' } } },
        { queryPrediction: { text: { text: 'koramangala cafes' } } },
        { placePrediction: { placeId: 'ChIJb', text: { text: 'Kormangala Club, Bengaluru' } } },
      ],
    });
    const out = await geocoder.search(' koraman ', { sessionToken: 'sess-1' });

    const { url, init } = onlyCall(fetchMock);
    expect(url.href).toBe('https://places.googleapis.com/v1/places:autocomplete');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('test-key');
    expect(JSON.parse(init.body as string)).toEqual({
      input: 'koraman',
      includedRegionCodes: ['in', 'us'],
      languageCode: 'en',
      sessionToken: 'sess-1',
    });
    // Query predictions carry no place and are dropped.
    expect(out.map((s) => s.placeId)).toEqual(['ChIJa', 'ChIJb']);
    expect(out[0]).toMatchObject({ label: 'Koramangala, Bengaluru, Karnataka, India', lat: null, lng: null, city: null });
  });

  it('scopes to one country when asked, and honours the limit', async () => {
    const fetchMock = respondWith({
      suggestions: [1, 2, 3].map((n) => ({ placePrediction: { placeId: `p${n}`, text: { text: `Place ${n}` } } })),
    });
    const out = await geocoder.search('main st', { country: 'USA', limit: 2 });
    expect(JSON.parse(onlyCall(fetchMock).init.body as string).includedRegionCodes).toEqual(['us']);
    expect(out).toHaveLength(2);
  });

  it('returns nothing on an HTTP error, and does not call Google for a blank query', async () => {
    respondWith({ error: { message: 'API key not valid' } }, 403);
    expect(await geocoder.search('pune')).toEqual([]);
    const fetchMock = respondWith({});
    expect(await geocoder.search('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GoogleGeocoder.resolve', () => {
  it('asks for Essentials fields only, ends the session, and fills the venue form fields', async () => {
    const fetchMock = respondWith(KORAMANGALA);
    const s = await geocoder.resolve('ChIJkoramangala', 'sess-1');

    const { url, init } = onlyCall(fetchMock);
    expect(url.pathname).toBe('/v1/places/ChIJkoramangala');
    expect(url.searchParams.get('sessionToken')).toBe('sess-1');
    expect((init.headers as Record<string, string>)['X-Goog-FieldMask']).toBe(
      'id,formattedAddress,addressComponents,location',
    );
    expect(s).toEqual({
      label: KORAMANGALA.formattedAddress,
      placeId: 'ChIJkoramangala',
      line1: '80 Feet Road, 4th Block, Koramangala',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560034',
      country: 'India',
      lat: 12.9352,
      lng: 77.6245,
    });
  });

  it('returns null for a place that no longer exists', async () => {
    respondWith({ error: { status: 'NOT_FOUND' } }, 404);
    expect(await geocoder.resolve('ChIJgone')).toBeNull();
  });
});

describe('toAddressParts', () => {
  it('builds a US street line and canonicalises the country', () => {
    expect(
      toAddressParts([
        { long: '100', short: '100', types: ['street_number'] },
        { long: 'Federal Street', short: 'Federal St', types: ['route'] },
        { long: 'Boston', short: 'Boston', types: ['locality', 'political'] },
        { long: 'Massachusetts', short: 'MA', types: ['administrative_area_level_1', 'political'] },
        { long: 'United States', short: 'US', types: ['country', 'political'] },
        { long: '02110', short: '02110', types: ['postal_code'] },
      ]),
    ).toEqual({
      line1: '100 Federal Street',
      city: 'Boston',
      state: 'Massachusetts',
      postalCode: '02110',
      country: 'USA',
    });
  });

  it('takes the borough as the city where there is no locality (New York)', () => {
    const parts = toAddressParts([
      { long: 'Atlantic Avenue', short: 'Atlantic Ave', types: ['route'] },
      { long: 'Brooklyn', short: 'Brooklyn', types: ['sublocality_level_1', 'sublocality', 'political'] },
      { long: 'New York', short: 'NY', types: ['administrative_area_level_1', 'political'] },
      { long: 'United States', short: 'US', types: ['country', 'political'] },
    ]);
    expect(parts.city).toBe('Brooklyn');
    expect(parts.line1).toBe('Atlantic Avenue');
  });
});

describe('GoogleGeocoder.geocode / reverse', () => {
  it('geocodes within the requested country and keeps the place ID', async () => {
    const fetchMock = respondWith({
      status: 'OK',
      results: [{ place_id: 'ChIJpune', geometry: { location: { lat: 18.52, lng: 73.86 } } }],
    });
    const p = await geocoder.geocode({ city: 'Pune', country: 'India' });
    const { url } = onlyCall(fetchMock);
    expect(url.origin + url.pathname).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect(url.searchParams.get('address')).toBe('Pune, India');
    expect(url.searchParams.get('components')).toBe('country:in');
    expect(p).toEqual({ lat: 18.52, lng: 73.86, placeId: 'ChIJpune' });
  });

  it('returns null when Google finds nothing', async () => {
    respondWith({ status: 'ZERO_RESULTS', results: [] });
    expect(await geocoder.geocode({ city: 'Nowhere', country: 'India' })).toBeNull();
  });

  it('names the city and canonical country for a point', async () => {
    respondWith({
      status: 'OK',
      results: [
        {
          address_components: [
            { long_name: 'Mysuru', short_name: 'Mysuru', types: ['locality', 'political'] },
            { long_name: 'India', short_name: 'IN', types: ['country', 'political'] },
          ],
        },
      ],
    });
    expect(await geocoder.reverse({ lat: 12.3, lng: 76.6 })).toEqual({ city: 'Mysuru', country: 'India' });
  });
});

describe('GoogleGeocoder narrowed by GOOGLE_MAPS_COUNTRIES', () => {
  const indiaOnly = new GoogleGeocoder('test-key', ['India']);
  const PREDICTION = { suggestions: [{ placePrediction: { placeId: 'ChIJx', text: { text: 'MG Road, Bengaluru' } } }] };

  it('suggests only in the configured country when the form names none', async () => {
    const fetchMock = respondWith(PREDICTION);
    await indiaOnly.search('MG Road');
    expect(JSON.parse(onlyCall(fetchMock).init.body as string).includedRegionCodes).toEqual(['in']);
  });

  it('returns nothing, without a billed request, for a country it does not cover', async () => {
    const fetchMock = respondWith(PREDICTION);
    expect(await indiaOnly.search('Main Street', { country: 'USA' })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('holds an address with no country to the one configured country', async () => {
    const fetchMock = respondWith({ status: 'ZERO_RESULTS', results: [] });
    await indiaOnly.geocode({ line1: '100 Feet Road', city: 'Bengaluru' });
    expect(onlyCall(fetchMock).url.searchParams.get('components')).toBe('country:in');
  });

  it('does not geocode an address in a country it does not cover', async () => {
    const fetchMock = respondWith({ status: 'OK', results: [] });
    expect(await indiaOnly.geocode({ city: 'Boston', country: 'USA' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a country-less address unfiltered while it covers several', async () => {
    // The Geocoding API filters by one country at a time.
    const fetchMock = respondWith({ status: 'ZERO_RESULTS', results: [] });
    await geocoder.geocode({ city: 'Pune' });
    expect(onlyCall(fetchMock).url.searchParams.get('components')).toBeNull();
  });
});
