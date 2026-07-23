import { afterEach, describe, expect, it } from 'vitest';
import {
  COUNTRY_CENTROID,
  canonicalizeCity,
  lookupGazetteer,
  normalizeCountry,
  searchGazetteer,
  suggestCity,
} from './gazetteer.js';
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

describe('canonicalizeCity', () => {
  it('folds aliases and case to the canonical spelling', () => {
    expect(canonicalizeCity('bangalore', 'India')).toBe('Bengaluru');
    expect(canonicalizeCity('Bombay', 'India')).toBe('Mumbai');
    expect(canonicalizeCity('  MYSORE ', 'India')).toBe('Mysuru');
    expect(canonicalizeCity('nyc', 'USA')).toBe('New York');
    expect(canonicalizeCity('bengaluru', 'India')).toBe('Bengaluru');
  });
  it('searches all served countries when the country is missing or unknown', () => {
    expect(canonicalizeCity('bangalore', null)).toBe('Bengaluru');
    expect(canonicalizeCity('boston', 'Germany')).toBe('Boston');
  });
  it('returns null for unknown cities and empty input (never destructive)', () => {
    expect(canonicalizeCity('Banagalore', 'India')).toBeNull();
    expect(canonicalizeCity('Springfield', 'India')).toBeNull();
    expect(canonicalizeCity('', 'India')).toBeNull();
    expect(canonicalizeCity(null, 'India')).toBeNull();
  });
});

describe('suggestCity', () => {
  it('suggests the canonical spelling for aliases', () => {
    expect(suggestCity('Bangalore', 'India')).toBe('Bengaluru');
    expect(suggestCity('bombay', 'India')).toBe('Mumbai');
  });
  it('suggests the nearest known city for small typos (the "Banagalore" case)', () => {
    expect(suggestCity('Banagalore', 'India')).toBe('Bengaluru');
    expect(suggestCity('Mumbay', 'India')).toBe('Mumbai');
    expect(suggestCity('Bostn', 'USA')).toBe('Boston');
  });
  it('stays silent when the input is already canonical (any case)', () => {
    expect(suggestCity('Bengaluru', 'India')).toBeNull();
    expect(suggestCity('bengaluru', 'India')).toBeNull();
  });
  it('stays silent for short input and things unlike any known city', () => {
    expect(suggestCity('Xy', 'India')).toBeNull();
    expect(suggestCity('Springfield', 'India')).toBeNull();
    expect(suggestCity(null, 'India')).toBeNull();
  });
  it('respects the country scope', () => {
    // "Bostn" is near Boston (USA) but nothing in India.
    expect(suggestCity('Bostn', 'India')).toBeNull();
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

  it('reverse() names the nearest gazetteer city when the point is close', async () => {
    const place = await getGeocoder().reverse({ lat: 28.61, lng: 77.2 }); // central Delhi
    expect(place).toEqual({ city: 'Delhi', country: 'India' });
  });

  it('reverse() title-cases multi-word cities', async () => {
    const place = await getGeocoder().reverse({ lat: 40.71, lng: -74.0 });
    expect(place).toEqual({ city: 'New York', country: 'USA' });
  });

  it('reverse() drops the city but keeps the country far from every listed city', async () => {
    const place = await getGeocoder().reverse({ lat: 34.15, lng: 77.57 }); // Leh, ~380 km from Chandigarh
    expect(place).toEqual({ city: null, country: 'India' });
  });
});
