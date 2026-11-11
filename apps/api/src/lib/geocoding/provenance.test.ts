import { describe, expect, it } from 'vitest';
import { coordsProvenance, placeIdSchema, sentCoordsProvenance, withoutGoogleCoords } from './provenance.js';

const NOW = new Date('2026-10-22T00:00:00Z');
const OURS = { coordsPlaceId: null, coordsFetchedAt: null };

describe('coordsProvenance', () => {
  it("marks coordinates with a place ID as Google's, fetched now", () => {
    expect(coordsProvenance('ChIJx', NOW)).toEqual({ coordsPlaceId: 'ChIJx', coordsFetchedAt: NOW });
  });
  it('marks coordinates without one as ours to keep', () => {
    expect(coordsProvenance(null, NOW)).toEqual(OURS);
    expect(coordsProvenance(undefined, NOW)).toEqual(OURS);
  });
});

describe('sentCoordsProvenance', () => {
  it('a pin picked from Google search carries its place', () => {
    expect(sentCoordsProvenance({ lat: 1, lng: 2, coordsPlaceId: 'ChIJx' }, null, NOW)).toEqual({
      coordsPlaceId: 'ChIJx',
      coordsFetchedAt: NOW,
    });
  });

  it("a moved pin (new coordinates, no place) is the partner's own", () => {
    expect(sentCoordsProvenance({ lat: 1.5, lng: 2 }, { lat: 1, lng: 2 }, NOW)).toEqual(OURS);
  });

  it('re-sending the stored pin leaves the provenance alone, place ID or not', () => {
    const stored = { lat: 1, lng: 2 };
    // Without a place ID, Google coordinates must not pass as the partner's…
    expect(sentCoordsProvenance({ lat: 1, lng: 2 }, stored, NOW)).toBeUndefined();
    // …and with one, re-saving must not restart Google's 30 days.
    expect(sentCoordsProvenance({ lat: 1, lng: 2, coordsPlaceId: 'ChIJx' }, stored, NOW)).toBeUndefined();
  });

  it('clearing the coordinates clears the provenance', () => {
    expect(sentCoordsProvenance({ lat: null, lng: null, coordsPlaceId: 'ChIJx' }, { lat: 1, lng: 2 }, NOW)).toEqual(
      OURS,
    );
  });
});

describe('placeIdSchema', () => {
  it('accepts Google place IDs and rejects anything that could break out of a URL path', () => {
    expect(placeIdSchema.safeParse('ChIJN1t_tDeuEmsRUsoyG83frY4').success).toBe(true);
    expect(placeIdSchema.safeParse('../secrets').success).toBe(false);
    expect(placeIdSchema.safeParse('a?b').success).toBe(false);
    expect(placeIdSchema.safeParse('').success).toBe(false);
  });

  it("accepts a street address's long place ID — Google sets no maximum", () => {
    expect(STREET_PLACE_ID.length).toBeGreaterThan(170);
    expect(placeIdSchema.safeParse(STREET_PLACE_ID).success).toBe(true);
    expect(placeIdSchema.safeParse('a'.repeat(1025)).success).toBe(false);
  });
});

/** A real Places API (New) ID for "100 Feet Road, HAL 2nd Stage, Indiranagar,
 * Bengaluru": 172 characters, as street addresses come back. */
const STREET_PLACE_ID =
  'Ek8xMDAgRmVldCBSb2FkLCBIQUwgMm5kIFN0YWdlLCBTdGFnZSAzLCBJbmRpcmFuYWdhciwgQmVuZ2FsdXJ1LCBLYXJuYXRha2EsIEluZGlhIi4qLAoUChIJQTt4fFwUrjsRXl20ikArF0gSFAoSCZ-SY5umFq47Efvf_nsHT_D2';

describe('sentCoordsProvenance fetch time', () => {
  const EARLIER = new Date('2026-10-01T00:00:00Z');

  it("keeps a known, earlier fetch time — a duplicate doesn't restart Google's 30 days", () => {
    expect(sentCoordsProvenance({ lat: 1, lng: 2, coordsPlaceId: 'ChIJx', coordsFetchedAt: EARLIER }, null, NOW))
      .toEqual({ coordsPlaceId: 'ChIJx', coordsFetchedAt: EARLIER });
  });

  it('never takes a time later than now', () => {
    const future = new Date(NOW.getTime() + 86_400_000);
    expect(sentCoordsProvenance({ lat: 1, lng: 2, coordsPlaceId: 'ChIJx', coordsFetchedAt: future }, null, NOW))
      .toEqual({ coordsPlaceId: 'ChIJx', coordsFetchedAt: NOW });
  });
});

describe('withoutGoogleCoords', () => {
  it("drops Google's coordinates but keeps the place", () => {
    expect(withoutGoogleCoords({ name: 'x', lat: 1, lng: 2, coordsPlaceId: 'ChIJx' }))
      .toEqual({ name: 'x', coordsPlaceId: 'ChIJx' });
  });

  it('uses the given place for a patch re-sending an unmoved Google pin', () => {
    expect(withoutGoogleCoords({ lat: 1, lng: 2 }, 'ChIJx')).toEqual({});
  });

  it("keeps the partner's own coordinates, including a pin just made theirs", () => {
    expect(withoutGoogleCoords({ lat: 1, lng: 2 })).toEqual({ lat: 1, lng: 2 });
    expect(withoutGoogleCoords({ lat: 1, lng: 2, coordsPlaceId: null }, 'ChIJold'))
      .toEqual({ lat: 1, lng: 2, coordsPlaceId: null });
  });
});
