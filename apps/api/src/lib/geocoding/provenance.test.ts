import { describe, expect, it } from 'vitest';
import { coordsProvenance, placeIdSchema, sentCoordsProvenance } from './provenance.js';

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
});
