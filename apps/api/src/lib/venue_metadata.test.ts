import { describe, expect, it } from 'vitest';
import { amenitiesSchema, openingHoursSchema, VENUE_AMENITIES } from './venue_metadata.js';

describe('amenitiesSchema (PR #109)', () => {
  it('accepts canonical amenities and de-dupes', () => {
    const parsed = amenitiesSchema.safeParse(['parking', 'wifi', 'parking']);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(['parking', 'wifi']);
  });

  it('rejects an unknown amenity', () => {
    expect(amenitiesSchema.safeParse(['parking', 'helipad']).success).toBe(false);
  });

  it('accepts the full canonical list', () => {
    expect(amenitiesSchema.safeParse([...VENUE_AMENITIES]).success).toBe(true);
  });
});

describe('openingHoursSchema (PR #109)', () => {
  it('accepts per-weekday ranges and closed days', () => {
    const parsed = openingHoursSchema.safeParse({
      '1': [{ open: '09:00', close: '22:00' }],
      '6': [{ open: '06:00', close: '12:00' }, { open: '16:00', close: '23:00' }],
      '0': [],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-HH:MM time', () => {
    expect(openingHoursSchema.safeParse({ '1': [{ open: '9am', close: '22:00' }] }).success).toBe(false);
  });

  it('rejects close <= open', () => {
    expect(openingHoursSchema.safeParse({ '1': [{ open: '22:00', close: '09:00' }] }).success).toBe(false);
  });

  it('rejects an out-of-range weekday key', () => {
    expect(openingHoursSchema.safeParse({ '7': [{ open: '09:00', close: '10:00' }] }).success).toBe(false);
  });
});
