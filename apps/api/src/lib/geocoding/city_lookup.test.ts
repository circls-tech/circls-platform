import { afterEach, describe, expect, it, vi } from 'vitest';

// The partner forms on Google; the consumer city lookup must stay off it.
vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GEOCODER_PROVIDER: 'google',
    GOOGLE_MAPS_SERVER_KEY: 'test-server-key',
    GEOCODER_BASE_URL: 'https://photon.example.test',
    GEOCODER_USER_AGENT: 'circls-test',
  },
}));

const { __resetGeocoderForTesting, getCityLookupGeocoder, getGeocoder } = await import('./index.js');

afterEach(() => {
  __resetGeocoderForTesting();
  vi.unstubAllGlobals();
});

describe('getCityLookupGeocoder with GEOCODER_PROVIDER=google', () => {
  it('uses Photon while the partner geocoder is Google', () => {
    expect(getGeocoder().mode).toBe('google');
    expect(getCityLookupGeocoder().mode).toBe('photon');
  });

  it('sends the reverse lookup to Photon, never to Google', async () => {
    const body = { features: [{ properties: { city: 'Pune', countrycode: 'IN' } }] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const place = await getCityLookupGeocoder().reverse({ lat: 18.52, lng: 73.86 });

    expect(place).toEqual({ city: 'Pune', country: 'India' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).origin).toBe('https://photon.example.test');
    expect(url).not.toContain('googleapis');
  });

  const reverseOf = async (properties: Record<string, string>, point: { lat: number; lng: number }) => {
    const body = { features: [{ properties }] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    return getCityLookupGeocoder().reverse(point);
  };

  it('never names a street: a feature with no city borrows a nearby known city', async () => {
    const place = await reverseOf(
      { type: 'street', name: '8th Main Road', county: 'Bangalore South', countrycode: 'IN' },
      { lat: 12.9352, lng: 77.6245 }, // Koramangala
    );
    expect(place).toEqual({ city: 'Bengaluru', country: 'India' });
  });

  it('falls back to the county away from every known city', async () => {
    const place = await reverseOf(
      { type: 'house', name: 'Some Shop', county: 'South Goa', countrycode: 'IN' },
      { lat: 15.2993, lng: 74.124 },
    );
    expect(place).toEqual({ city: 'South Goa', country: 'India' });
  });

  it('uses the name when the feature is itself a city', async () => {
    const place = await reverseOf(
      { type: 'city', name: 'Margao', county: 'South Goa', countrycode: 'IN' },
      { lat: 15.2832, lng: 73.9862 },
    );
    expect(place).toEqual({ city: 'Margao', country: 'India' });
  });

  it('recognises a town on a Photon build that sends no type', async () => {
    const place = await reverseOf(
      { osm_key: 'place', osm_value: 'town', name: 'Margao', county: 'South Goa', countrycode: 'IN' },
      { lat: 15.2832, lng: 73.9862 },
    );
    expect(place).toEqual({ city: 'Margao', country: 'India' });
  });

  it('names a county feature after itself, with its state', async () => {
    const place = await reverseOf(
      { type: 'county', name: 'South Goa', state: 'Goa', countrycode: 'IN' },
      { lat: 15.2993, lng: 74.124 },
    );
    expect(place).toEqual({ city: 'South Goa, Goa', country: 'India' });
  });

  it('borrows a known city on its outskirts when the county agrees', async () => {
    const place = await reverseOf(
      { type: 'street', name: 'ITPL Main Road', county: 'Bangalore East', state: 'Karnataka', countrycode: 'IN' },
      { lat: 12.9698, lng: 77.75 }, // Whitefield, ~17 km from the centre
    );
    expect(place).toEqual({ city: 'Bengaluru', country: 'India' });
  });

  it('does not borrow the big city next door when the county names another place', async () => {
    const place = await reverseOf(
      { type: 'street', name: 'Palm Beach Road', county: 'Thane', state: 'Maharashtra', countrycode: 'IN' },
      { lat: 19.033, lng: 73.03 }, // Navi Mumbai, ~17 km from Mumbai's centre
    );
    expect(place).toEqual({ city: 'Thane, Maharashtra', country: 'India' });
  });

  it('never borrows a known city across a border', async () => {
    const place = await reverseOf(
      { type: 'street', name: 'Some Road', county: 'Elsewhere', countrycode: 'NP', country: 'Nepal' },
      { lat: 28.6139, lng: 77.209 }, // Delhi's centre, but Photon says Nepal
    );
    expect(place).toEqual({ city: 'Elsewhere', country: 'Nepal' });
  });

  it('falls back to the state, then to no city at all', async () => {
    const leh = { lat: 34.15, lng: 77.57 };
    expect(
      await reverseOf({ type: 'street', name: 'Fort Road', state: 'Ladakh', countrycode: 'IN' }, leh),
    ).toEqual({ city: 'Ladakh', country: 'India' });
    expect(await reverseOf({ type: 'street', name: 'Fort Road', countrycode: 'IN' }, leh)).toEqual({
      city: null,
      country: 'India',
    });
  });
});
