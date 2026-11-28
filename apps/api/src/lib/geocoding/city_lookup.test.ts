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
});
