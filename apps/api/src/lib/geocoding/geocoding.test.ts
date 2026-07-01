import { afterEach, describe, expect, it } from 'vitest';
import { COUNTRY_CENTROID, lookupGazetteer, normalizeCountry, searchGazetteer } from './gazetteer.js';
import { __resetGeocoderForTesting, getGeocoder, hasGeocodableAddress } from './index.js';

afterEach(() => __resetGeocoderForTesting());

describe('normalizeCountry', () => {
  it('folds common spellings to a canonical bucket', () => {
    expect(normalizeCountry('India')).toBe('India');
    expect(normalizeCountry('  india ')).toBe('India');
    expect(normalizeCountry('IN')).toBe('India');
    expect(normalizeCountry('USA')).toBe('USA');
    expect(normalizeCountry('United States')).toBe('USA');
    expect(normalizeCountry('us')).toBe('USA');
  });

  it('returns null for unknown or empty countries', () => {
    expect(normalizeCountry('Narnia')).toBeNull();
    expect(normalizeCountry('')).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
  });
});

describe('lookupGazetteer', () => {
  it('resolves a known city within a known country', () => {
    const p = lookupGazetteer('Bengaluru', 'India');
    expect(p).not.toBeNull();
    expect(p!.lat).toBeCloseTo(12.97, 1);
    expect(p!.lng).toBeCloseTo(77.59, 1);
  });

  it('honours city aliases', () => {
    expect(lookupGazetteer('Bangalore', 'India')).toEqual(lookupGazetteer('Bengaluru', 'India'));
    expect(lookupGazetteer('NYC', 'USA')).toEqual(lookupGazetteer('New York', 'USA'));
  });

  it('falls back to the country centroid for an unknown city', () => {
    expect(lookupGazetteer('Nowheresville', 'India')).toEqual(COUNTRY_CENTROID.India);
    expect(lookupGazetteer(null, 'USA')).toEqual(COUNTRY_CENTROID.USA);
  });

  it('returns null when the country itself is unrecognised', () => {
    expect(lookupGazetteer('Paris', 'France')).toBeNull();
    expect(lookupGazetteer('Somewhere', null)).toBeNull();
  });
});

describe('hasGeocodableAddress', () => {
  it('is true when a city or country is present', () => {
    expect(hasGeocodableAddress({ city: 'Pune' })).toBe(true);
    expect(hasGeocodableAddress({ country: 'India' })).toBe(true);
  });
  it('is false for a blank address', () => {
    expect(hasGeocodableAddress({})).toBe(false);
    expect(hasGeocodableAddress({ city: '  ', country: '' })).toBe(false);
  });
});

describe('searchGazetteer', () => {
  it('prefix-matches cities, ranking prefixes above substrings', () => {
    const hits = searchGazetteer('ben');
    expect(hits[0]?.city).toBe('Bengaluru');
    expect(hits[0]?.country).toBe('India');
  });

  it('scopes to a country when given', () => {
    const all = searchGazetteer('san');
    const us = searchGazetteer('san', 'USA');
    expect(us.every((h) => h.country === 'USA')).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(us.length);
  });

  it('returns nothing for a blank query', () => {
    expect(searchGazetteer('')).toEqual([]);
  });
});

describe('getGeocoder (stub default)', () => {
  it('defaults to the stub gazetteer geocoder', async () => {
    const g = getGeocoder();
    expect(g.mode).toBe('stub');
    const point = await g.geocode({ city: 'Chennai', country: 'India' });
    expect(point).not.toBeNull();
    expect(point!.lat).toBeCloseTo(13.08, 1);
  });

  it('returns null for an address it cannot resolve', async () => {
    const point = await getGeocoder().geocode({ city: 'Lyon', country: 'France' });
    expect(point).toBeNull();
  });

  it('search() returns fillable suggestions with coordinates', async () => {
    const out = await getGeocoder().search('mumb', { country: 'India' });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]).toMatchObject({ city: 'Mumbai', country: 'India' });
    expect(typeof out[0]!.lat).toBe('number');
    expect(out[0]!.label).toContain('Mumbai');
  });
});
