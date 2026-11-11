import { describe, expect, it } from 'vitest';
import { occurrenceCoords } from './events.js';

const FETCHED = new Date('2026-11-01T10:00:00Z');
const BASE = { lat: 18.52, lng: 73.86, coordsPlaceId: 'ChIJbase', coordsFetchedAt: FETCHED };

describe('occurrenceCoords — where one standalone date of a series is', () => {
  it("inherits the base event's pin, with its place and fetch time", () => {
    expect(occurrenceCoords({}, BASE)).toEqual(BASE);
  });

  it('keeps its own coordinates and place', () => {
    expect(
      occurrenceCoords(
        { lat: 12.97, lng: 77.64, coordsPlaceId: 'ChIJown', coordsFetchedAt: '2026-11-05T00:00:00Z' },
        BASE,
      ),
    ).toEqual({ lat: 12.97, lng: 77.64, coordsPlaceId: 'ChIJown', coordsFetchedAt: new Date('2026-11-05T00:00:00Z') });
  });

  it("with only its own address, takes no coordinates — so that address is geocoded, not pinned at the base's spot", () => {
    expect(occurrenceCoords({ addressJson: { city: 'Mumbai', country: 'India' } }, BASE)).toEqual({
      lat: undefined,
      lng: undefined,
      coordsPlaceId: undefined,
      coordsFetchedAt: undefined,
    });
  });
});
