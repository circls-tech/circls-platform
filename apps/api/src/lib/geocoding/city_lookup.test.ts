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
});
