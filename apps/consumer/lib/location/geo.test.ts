import { describe, expect, it } from 'vitest';
import type { PublicVenue } from '@/lib/api/types';
import {
  cityOf,
  countryForCity,
  countryOf,
  derivePlaces,
  eventInRange,
  haversineKm,
  inArea,
  inCountry,
  matchesCountry,
  membershipInArea,
  nearestCity,
  sameCountry,
  venueToLocatable,
  venuesForArea,
  type Locatable,
} from './geo';

function place(p: Partial<Locatable>): Locatable {
  return { city: null, country: null, lat: null, lng: null, ...p };
}

function venue(over: {
  lat?: number | null;
  lng?: number | null;
  addressJson?: Record<string, unknown> | null;
  address?: Partial<PublicVenue['address']>;
} = {}): PublicVenue {
  return {
    id: 'v1',
    name: 'V',
    tags: [],
    lat: over.lat ?? null,
    lng: over.lng ?? null,
    addressJson: over.addressJson ?? null,
    description: null,
    amenities: [],
    openingHours: null,
    contactPhone: null,
    contactEmail: null,
    address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null, ...over.address },
    brand: { id: 't1', slug: 's', name: 'B', logoUrl: null },
    images: [],
  } as PublicVenue;
}

describe('venueToLocatable', () => {
  it('reads the structured address when address_json is null (existing venues)', () => {
    const loc = venueToLocatable(
      venue({ lat: 21.13, lng: 79.05, addressJson: null, address: { city: 'Nagpur', country: 'India' } }),
    );
    expect(loc).toEqual({ city: 'Nagpur', country: 'India', lat: 21.13, lng: 79.05 });
  });

  it('falls back to address_json when structured columns are empty', () => {
    const loc = venueToLocatable(venue({ addressJson: { city: 'Pune', country: 'India' } }));
    expect(loc.city).toBe('Pune');
    expect(loc.country).toBe('India');
  });

  it('prefers structured over address_json when both are present', () => {
    const loc = venueToLocatable(
      venue({ addressJson: { city: 'Stale', country: 'India' }, address: { city: 'Nagpur', country: 'India' } }),
    );
    expect(loc.city).toBe('Nagpur');
  });
});

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

describe('matchesCountry', () => {
  it('matches everything when no country is selected', () => {
    expect(matchesCountry('India', null)).toBe(true);
    expect(matchesCountry(null, null)).toBe(true);
  });
  it('keeps only same-country values once a country is selected', () => {
    // The membership case: an India plan must not show for a USA selection.
    expect(matchesCountry('India', 'USA')).toBe(false);
    expect(matchesCountry('USA', 'USA')).toBe(true);
    expect(matchesCountry(' usa ', 'USA')).toBe(true);
  });
  it('shows untagged values everywhere (lenient)', () => {
    expect(matchesCountry(null, 'USA')).toBe(true);
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

describe('venuesForArea (hard city filter)', () => {
  const nagpur = venue({ address: { city: 'Nagpur', country: 'India' } });
  const mumbai = venue({ addressJson: { city: 'Mumbai', country: 'India' } });
  const noCity = venue({ addressJson: { country: 'India' } });
  const boston = venue({ address: { city: 'Boston', country: 'USA' } });
  const all = [nagpur, mumbai, noCity, boston];

  it('keeps only the selected city (structured or freeform address, case-insensitive)', () => {
    expect(venuesForArea(all, { city: 'nagpur', country: 'India' })).toEqual([nagpur]);
    expect(venuesForArea(all, { city: 'Mumbai', country: 'India' })).toEqual([mumbai]);
  });

  it('returns empty (not the whole country) when the city has no venues', () => {
    expect(venuesForArea(all, { city: 'Pune', country: 'India' })).toEqual([]);
  });

  it('hides venues without a city while a city is selected', () => {
    expect(venuesForArea([noCity], { city: 'Nagpur', country: 'India' })).toEqual([]);
  });

  it('is country-wide (untagged included) when only a country is selected', () => {
    expect(venuesForArea(all, { city: null, country: 'India' })).toEqual([nagpur, mumbai, noCity]);
  });

  it('matches everything with an empty selection', () => {
    expect(venuesForArea(all, { city: null, country: null })).toEqual(all);
  });
});

describe('venuesForArea (nearby radius — the Delhi case)', () => {
  // Nagpur venue with real coordinates; a Delhi user is ~700 km away.
  const nagpurGeo = venue({ lat: 21.1458, lng: 79.0882, address: { city: 'Nagpur', country: 'India' } });
  const noGeo = venue({ address: { city: 'Nagpur', country: 'India' } });
  const delhi = { lat: 28.6139, lng: 77.209 };
  const nagpurUser = { lat: 21.13, lng: 79.05 };

  it('hides geolocated venues outside the radius when only coords are shared', () => {
    expect(venuesForArea([nagpurGeo], { city: null, country: 'India', coords: delhi })).toEqual([]);
  });

  it('keeps geolocated venues within the radius', () => {
    expect(venuesForArea([nagpurGeo], { city: null, country: 'India', coords: nagpurUser })).toEqual([nagpurGeo]);
  });

  it('keeps ungeocoded venues via the lenient country fallback', () => {
    expect(venuesForArea([noGeo], { city: null, country: 'India', coords: delhi })).toEqual([noGeo]);
  });

  it('lets a selected city override the radius (manual pick wins)', () => {
    // City selection means "show me that city", even from far away.
    expect(venuesForArea([nagpurGeo], { city: 'Nagpur', country: 'India', coords: delhi })).toEqual([nagpurGeo]);
  });
});

describe('membershipInArea', () => {
  const scoped = { city: 'Nagpur', country: 'India' };
  const otherCity = { city: 'Mumbai', country: 'India' };
  const brandWide = { city: null, country: 'India' };
  const usPlan = { city: 'Boston', country: 'USA' };

  it('hard-filters venue-scoped plans by city', () => {
    expect(membershipInArea(scoped, { city: 'Nagpur', country: 'India' })).toBe(true);
    expect(membershipInArea(scoped, { city: 'nagpur ', country: 'India' })).toBe(true);
    expect(membershipInArea(otherCity, { city: 'Nagpur', country: 'India' })).toBe(false);
  });

  it('keeps tenant-wide plans (no city) visible across the country', () => {
    expect(membershipInArea(brandWide, { city: 'Nagpur', country: 'India' })).toBe(true);
    expect(membershipInArea(brandWide, { city: null, country: 'India' })).toBe(true);
  });

  it('never crosses the country boundary', () => {
    expect(membershipInArea(usPlan, { city: 'Nagpur', country: 'India' })).toBe(false);
    expect(membershipInArea(brandWide, { city: 'Boston', country: 'USA' })).toBe(false);
  });

  it('matches everything with an empty selection', () => {
    expect(membershipInArea(usPlan, { city: null, country: null })).toBe(true);
    expect(membershipInArea(brandWide, { city: null, country: null })).toBe(true);
  });

  describe('nearby radius (the Delhi case)', () => {
    const delhi = { lat: 28.6139, lng: 77.209 };
    const nagpurUser = { lat: 21.13, lng: 79.05 };
    const nagpurPlan = { city: 'Nagpur', country: 'India', lat: 21.1458, lng: 79.0882 };
    const noGeoPlan = { city: 'Nagpur', country: 'India', lat: null, lng: null };

    it('hides venue-scoped plans outside the radius when only coords are shared', () => {
      expect(membershipInArea(nagpurPlan, { city: null, country: 'India', coords: delhi })).toBe(false);
    });

    it('keeps venue-scoped plans within the radius', () => {
      expect(membershipInArea(nagpurPlan, { city: null, country: 'India', coords: nagpurUser })).toBe(true);
    });

    it('keeps brand-wide and ungeocoded plans via the country fallback', () => {
      expect(membershipInArea(brandWide, { city: null, country: 'India', coords: delhi })).toBe(true);
      expect(membershipInArea(noGeoPlan, { city: null, country: 'India', coords: delhi })).toBe(true);
    });
  });
});

describe('eventInRange', () => {
  // MG Road, Bengaluru — the "user".
  const me = { lat: 12.975, lng: 77.606 };
  const ev = (over: Partial<{ locLat: number | null; locLng: number | null; locAddressJson: Record<string, unknown> | null }>) => ({
    locLat: null,
    locLng: null,
    locAddressJson: null,
    ...over,
  });

  it('keeps events within 50 km of the shared location', () => {
    // Whitefield is ~15 km from MG Road.
    expect(eventInRange(ev({ locLat: 12.97, locLng: 77.75 }), { city: 'Bengaluru', country: 'India', coords: me })).toBe(true);
  });

  it('drops geolocated events beyond the radius, even in the same country', () => {
    // Mysuru is ~140 km away — same country, outside the radius.
    expect(eventInRange(ev({ locLat: 12.3, locLng: 76.64, locAddressJson: { city: 'Mysuru', country: 'India' } }), { city: 'Bengaluru', country: 'India', coords: me })).toBe(false);
  });

  it('keeps a cross-border event that is physically near the user', () => {
    // Distance is the boundary when coords are shared — country is irrelevant.
    expect(eventInRange(ev({ locLat: 12.98, locLng: 77.61, locAddressJson: { country: 'Elsewhere' } }), { city: null, country: 'India', coords: me })).toBe(true);
  });

  it('falls back to the country check for events without coordinates (lenient)', () => {
    expect(eventInRange(ev({ locAddressJson: { city: 'Pune', country: 'India' } }), { city: null, country: 'India', coords: me })).toBe(true);
    expect(eventInRange(ev({ locAddressJson: { country: 'USA' } }), { city: null, country: 'India', coords: me })).toBe(false);
    expect(eventInRange(ev({}), { city: null, country: 'India', coords: me })).toBe(true);
  });

  it('is the plain country check when no coords are set (manual city pick)', () => {
    // Mysuru event, Bengaluru picked manually: whole-country view keeps it.
    expect(eventInRange(ev({ locLat: 12.3, locLng: 76.64, locAddressJson: { country: 'India' } }), { city: 'Bengaluru', country: 'India', coords: null })).toBe(true);
    expect(eventInRange(ev({ locAddressJson: { country: 'USA' } }), { city: 'Bengaluru', country: 'India' })).toBe(false);
  });

  it('respects a custom radius', () => {
    // ~15 km away: inside 50 km, outside 5 km.
    const whitefield = ev({ locLat: 12.97, locLng: 77.75 });
    expect(eventInRange(whitefield, { city: null, country: null, coords: me }, 5)).toBe(false);
    expect(eventInRange(whitefield, { city: null, country: null, coords: me }, 50)).toBe(true);
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
