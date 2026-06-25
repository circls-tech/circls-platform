import { describe, expect, it } from 'vitest';
import {
  cityOf,
  countryForCity,
  countryOf,
  derivePlaces,
  haversineKm,
  inArea,
  inCountry,
  nearestCity,
  sameCountry,
  type Locatable,
} from './geo';

function place(p: Partial<Locatable>): Locatable {
  return { city: null, country: null, lat: null, lng: null, ...p };
}

describe('cityOf / countryOf', () => {
  it('reads and trims string fields', () => {
    expect(cityOf({ city: '  Bengaluru ' })).toBe('Bengaluru');
    expect(countryOf({ country: ' India ' })).toBe('India');
  });
  it('returns null when absent, blank, or non-string', () => {
    expect(cityOf(null)).toBeNull();
    expect(countryOf({ country: '   ' })).toBeNull();
    expect(countryOf({ country: 42 })).toBeNull();
  });
});

describe('sameCountry', () => {
  it('compares case-insensitively and trims', () => {
    expect(sameCountry('India', ' india ')).toBe(true);
    expect(sameCountry('USA', 'India')).toBe(false);
  });
  it('is false when either side is null', () => {
    expect(sameCountry(null, 'India')).toBe(false);
    expect(sameCountry('India', null)).toBe(false);
  });
});

describe('derivePlaces', () => {
  it('groups by city, counts, captures country, and averages coordinates', () => {
    const cities = derivePlaces([
      place({ city: 'Bengaluru', country: 'India', lat: 12.9, lng: 77.6 }),
      place({ city: 'bengaluru', country: 'India', lat: 13.1, lng: 77.8 }),
      place({ city: 'Boston', country: 'USA', lat: 42.36, lng: -71.06 }),
    ]);
    expect(cities).toHaveLength(2);
    expect(cities[0].city).toBe('Bengaluru');
    expect(cities[0].country).toBe('India');
    expect(cities[0].count).toBe(2);
    expect(cities[0].lat).toBeCloseTo(13.0, 5);
    expect(cities[0].hasCoords).toBe(true);
    expect(cities[1].city).toBe('Boston');
    expect(cities[1].country).toBe('USA');
  });
  it('ignores entries without a city and marks coordinate-less cities', () => {
    const cities = derivePlaces([
      place({ city: null, lat: 1, lng: 1 }),
      place({ city: 'Pune', country: 'India' }),
    ]);
    expect(cities).toHaveLength(1);
    expect(cities[0].city).toBe('Pune');
    expect(cities[0].hasCoords).toBe(false);
  });
});

describe('countryForCity', () => {
  const cities = derivePlaces([
    place({ city: 'Bengaluru', country: 'India', lat: 12.9, lng: 77.6 }),
    place({ city: 'Boston', country: 'USA', lat: 42.36, lng: -71.06 }),
  ]);
  it('resolves the country of a city, case-insensitively', () => {
    expect(countryForCity(cities, 'boston')).toBe('USA');
    expect(countryForCity(cities, 'Bengaluru')).toBe('India');
  });
  it('returns null for unknown city or null input', () => {
    expect(countryForCity(cities, 'Tokyo')).toBeNull();
    expect(countryForCity(cities, null)).toBeNull();
  });
});

describe('inCountry', () => {
  const india = { city: 'Bengaluru', country: 'India' };
  const usa = { city: 'Boston', country: 'USA' };
  it('matches everything when no country is selected', () => {
    expect(inCountry(india, null)).toBe(true);
    expect(inCountry(usa, null)).toBe(true);
  });
  it('keeps only same-country places once a country is selected', () => {
    expect(inCountry(usa, 'USA')).toBe(true);
    expect(inCountry(india, 'USA')).toBe(false);
    expect(inCountry(india, 'India')).toBe(true);
  });
  it('shows places with no country everywhere (lenient)', () => {
    expect(inCountry({ city: 'Nowhere' }, 'USA')).toBe(true);
    expect(inCountry(null, 'India')).toBe(true);
  });
});

describe('inArea', () => {
  const crimson = { city: 'Bengaluru', country: 'India' };
  it('filters by country first, then city', () => {
    // US user (country only): the India venue is hidden.
    expect(inArea(crimson, { city: null, country: 'USA' })).toBe(false);
    // India user, no city: shown.
    expect(inArea(crimson, { city: null, country: 'India' })).toBe(true);
    // India user in a different city: hidden.
    expect(inArea(crimson, { city: 'Mumbai', country: 'India' })).toBe(false);
    // India user in Bengaluru: shown.
    expect(inArea(crimson, { city: 'Bengaluru', country: 'India' })).toBe(true);
  });
  it('matches everything with an empty selection', () => {
    expect(inArea(crimson, { city: null, country: null })).toBe(true);
  });
});

describe('nearestCity', () => {
  const cities = derivePlaces([
    place({ city: 'Bengaluru', country: 'India', lat: 12.97, lng: 77.59 }),
    place({ city: 'Boston', country: 'USA', lat: 42.36, lng: -71.06 }),
    place({ city: 'NoGeo', country: 'India' }),
  ]);
  it('picks the closest geolocated city', () => {
    expect(nearestCity({ lat: 42.3, lng: -71.0 }, cities)?.city.city).toBe('Boston');
    expect(nearestCity({ lat: 12.9, lng: 77.6 }, cities)?.city.city).toBe('Bengaluru');
  });
  it('resolves to the nearest country even when far from any city (US west coast → USA)', () => {
    // Regression: a San Francisco user is ~4,300 km from Boston but ~14,000 km
    // from Bengaluru, so their nearest market is the USA — not India.
    const near = nearestCity({ lat: 37.77, lng: -122.42 }, cities);
    expect(near?.city.country).toBe('USA');
    // Far enough that the provider keeps the country but drops the city label.
    expect(near?.distanceKm).toBeGreaterThan(150);
  });
  it('returns null when no city has coordinates', () => {
    const noGeo = derivePlaces([place({ city: 'NoGeo', country: 'India' })]);
    expect(nearestCity({ lat: 0, lng: 0 }, noGeo)).toBeNull();
  });
});

describe('haversineKm', () => {
  it('is ~0 for identical points', () => {
    expect(haversineKm({ lat: 12.9, lng: 77.6 }, { lat: 12.9, lng: 77.6 })).toBeCloseTo(0, 5);
  });
  it('approximates a known distance (Bengaluru → Boston ≈ 13,800 km)', () => {
    const d = haversineKm({ lat: 12.97, lng: 77.59 }, { lat: 42.36, lng: -71.06 });
    expect(d).toBeGreaterThan(13_000);
    expect(d).toBeLessThan(14_500);
  });
});
