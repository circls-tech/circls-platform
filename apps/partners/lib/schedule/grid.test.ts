import { describe, expect, it } from 'vitest';
import { compareTimeKeys, gridDayIndex, sortTimeKeys } from './grid';

describe('sortTimeKeys', () => {
  const keys = ['00:00', '02:00', '06:00', '22:00', '23:00'];

  it('with dayStartMin=0 sorts lexically (calendar day)', () => {
    expect(sortTimeKeys(keys, 0)).toEqual(['00:00', '02:00', '06:00', '22:00', '23:00']);
  });

  it('with dayStartMin=180 orders from 3am through to 2am', () => {
    expect(sortTimeKeys(keys, 180)).toEqual(['06:00', '22:00', '23:00', '00:00', '02:00']);
  });
});

describe('compareTimeKeys', () => {
  it('places a 2am row after a 10pm row under a 3am business day', () => {
    expect(compareTimeKeys('22:00', '02:00', 180)).toBeLessThan(0);
  });
});

describe('gridDayIndex', () => {
  const tz = 'Asia/Kolkata';
  // Sunday 2026-06-14 (local midnight); weekStart.getDay() === 0.
  const weekStart = new Date('2026-06-14T00:00:00');

  it('buckets a Monday-evening slot into the Monday column', () => {
    // Mon 2026-06-15 20:00 IST = 14:30Z
    const iso = '2026-06-15T14:30:00.000Z';
    expect(gridDayIndex(iso, tz, weekStart, 0)).toBe(1); // Monday
    expect(gridDayIndex(iso, tz, weekStart, 180)).toBe(1); // still Monday (well after 3am)
  });

  it('buckets a Tuesday-2am slot into the Monday business day when dayStart=3am', () => {
    // Tue 2026-06-16 02:00 IST = Mon 2026-06-15 20:30Z
    const iso = '2026-06-15T20:30:00.000Z';
    expect(gridDayIndex(iso, tz, weekStart, 0)).toBe(2); // Tuesday (calendar)
    expect(gridDayIndex(iso, tz, weekStart, 180)).toBe(1); // Monday (business day)
  });
});
