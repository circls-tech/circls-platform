import { describe, expect, it } from 'vitest';
import { coordsPlaceIdOf, coordsProvenanceOf, ownPin } from './map_view';

const GOOGLE_PIN = { lat: 12.97, lng: 77.64, placeId: 'ChIJx', fetchedAt: '2026-11-01T10:00:00.000Z' };

describe('the place ID lifecycle of a pin', () => {
  it('a click or drag makes the pin the partner\'s own: no place, no fetch time', () => {
    expect(ownPin(12.98, 77.65)).toEqual({ lat: 12.98, lng: 77.65, placeId: null, fetchedAt: null });
    expect(coordsPlaceIdOf(ownPin(12.98, 77.65))).toEqual({});
    expect(coordsProvenanceOf(ownPin(12.98, 77.65))).toEqual({});
  });

  it('an update sends the place of an unmoved Google pin', () => {
    expect(coordsPlaceIdOf(GOOGLE_PIN)).toEqual({ coordsPlaceId: 'ChIJx' });
  });

  it('a create also sends when Google returned it', () => {
    expect(coordsProvenanceOf(GOOGLE_PIN)).toEqual({
      coordsPlaceId: 'ChIJx',
      coordsFetchedAt: '2026-11-01T10:00:00.000Z',
    });
    expect(coordsProvenanceOf({ ...GOOGLE_PIN, fetchedAt: null })).toEqual({ coordsPlaceId: 'ChIJx' });
  });
});
