import { describe, expect, it } from 'vitest';
import { reverseGeocodeQuery } from './consumer.js';

// Pure validation tests (no DB) for GET /v1/consumer/geocode/reverse. The
// resolution itself is covered by the geocoder tests (lib/geocoding).
describe('reverse geocode query validation', () => {
  it('accepts numeric query strings (what URLSearchParams sends)', () => {
    const r = reverseGeocodeQuery.safeParse({ lat: '28.6139', lng: '77.209' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ lat: 28.6139, lng: 77.209 });
  });

  it('rejects out-of-range coordinates', () => {
    expect(reverseGeocodeQuery.safeParse({ lat: '91', lng: '0' }).success).toBe(false);
    expect(reverseGeocodeQuery.safeParse({ lat: '0', lng: '-181' }).success).toBe(false);
  });

  it('rejects missing or non-numeric parts', () => {
    expect(reverseGeocodeQuery.safeParse({ lat: '12.9' }).success).toBe(false);
    expect(reverseGeocodeQuery.safeParse({ lat: 'abc', lng: '77' }).success).toBe(false);
  });
});
