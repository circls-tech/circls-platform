import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  boundsOfCalendarDateInTz,
  calendarDateInTz,
  canonicalTz,
  isCalendarDate,
  dayBoundsInTz,
  rangeBoundsInTz,
} from './time';

describe('calendarDateInTz', () => {
  it('reads the local calendar date, not the UTC one', () => {
    // 18:30 UTC on 30 Sep is already 1 Oct in India (+5:30).
    const instant = new Date('2026-09-30T18:30:00Z');
    expect(calendarDateInTz(instant, 'UTC')).toBe('2026-09-30');
    expect(calendarDateInTz(instant, 'Asia/Kolkata')).toBe('2026-10-01');
    // And still 30 Sep in New York (−4).
    expect(calendarDateInTz(instant, 'America/New_York')).toBe('2026-09-30');
  });
});

describe('addCalendarDays', () => {
  it('moves whole calendar days across month and year ends', () => {
    expect(addCalendarDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addCalendarDays('2026-10-01', -6)).toBe('2026-09-25');
    expect(addCalendarDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });

  it('is unaffected by a DST change inside the span', () => {
    // US clocks go forward on 8 Mar 2026; seven calendar days is still seven.
    expect(addCalendarDays('2026-03-12', -7)).toBe('2026-03-05');
  });
});

describe('boundsOfCalendarDateInTz', () => {
  it('bounds a day in a half-hour offset zone', () => {
    expect(boundsOfCalendarDateInTz('2026-10-01', 'Asia/Kolkata')).toEqual({
      from: '2026-09-30T18:30:00.000Z',
      to: '2026-10-01T18:30:00.000Z',
    });
  });

  it('bounds a day in UTC', () => {
    expect(boundsOfCalendarDateInTz('2026-10-01', 'UTC')).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
    });
  });

  it('bounds a day in a zone WEST of UTC', () => {
    // The regression this module was written for: sampling the offset at
    // 00:00 UTC and subtracting put a US day a full day early, because
    // 00:00 UTC on the 15th is still the evening of the 14th in New York.
    expect(boundsOfCalendarDateInTz('2026-01-15', 'America/New_York')).toEqual({
      from: '2026-01-15T05:00:00.000Z',
      to: '2026-01-16T05:00:00.000Z',
    });
  });

  it('uses the offset in force on that date, not another season s', () => {
    // New York is −05:00 in January and −04:00 in July.
    expect(boundsOfCalendarDateInTz('2026-01-15', 'America/New_York').from).toBe(
      '2026-01-15T05:00:00.000Z',
    );
    expect(boundsOfCalendarDateInTz('2026-07-15', 'America/New_York').from).toBe(
      '2026-07-15T04:00:00.000Z',
    );
  });

  it('gives a 23-hour day when the clocks go forward', () => {
    // US DST begins 08 Mar 2026 at 02:00 local: that day is 23 hours long.
    const { from, to } = boundsOfCalendarDateInTz('2026-03-08', 'America/New_York');
    expect(from).toBe('2026-03-08T05:00:00.000Z');
    expect(to).toBe('2026-03-09T04:00:00.000Z');
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(23 * 3600 * 1000);
  });

  it('gives a 25-hour day when the clocks go back', () => {
    // US DST ends 01 Nov 2026 at 02:00 local: that day is 25 hours long.
    const { from, to } = boundsOfCalendarDateInTz('2026-11-01', 'America/New_York');
    expect(new Date(to).getTime() - new Date(from).getTime()).toBe(25 * 3600 * 1000);
  });

  it('bounds a day west of the date line', () => {
    // Chatham Islands: +12:45 standard, +13:45 in their summer.
    expect(boundsOfCalendarDateInTz('2026-07-15', 'Pacific/Chatham').from).toBe(
      '2026-07-14T11:15:00.000Z',
    );
  });
});

describe('dayBoundsInTz', () => {
  it('bounds the local calendar day an instant falls on', () => {
    // Late evening IST on 1 Oct — the window must be 1 Oct IST, not 30 Sep.
    expect(dayBoundsInTz(new Date('2026-10-01T17:00:00Z'), 'Asia/Kolkata')).toEqual({
      from: '2026-09-30T18:30:00.000Z',
      to: '2026-10-01T18:30:00.000Z',
    });
  });

  it("accepts 'today' without throwing", () => {
    const { from, to } = dayBoundsInTz('today', 'Asia/Kolkata');
    expect(new Date(from).getTime()).toBeLessThan(new Date(to).getTime());
  });
});

describe('rangeBoundsInTz', () => {
  it('spans from the first midnight to the last day s end', () => {
    expect(rangeBoundsInTz('2026-09-25', '2026-10-01', 'Asia/Kolkata')).toEqual({
      from: '2026-09-24T18:30:00.000Z',
      to: '2026-10-01T18:30:00.000Z',
    });
  });

  it('includes the whole of a single-day range', () => {
    expect(rangeBoundsInTz('2026-10-01', '2026-10-01', 'UTC')).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
    });
  });

  it('swaps reversed bounds rather than returning an empty window', () => {
    expect(rangeBoundsInTz('2026-10-01', '2026-09-25', 'Asia/Kolkata')).toEqual(
      rangeBoundsInTz('2026-09-25', '2026-10-01', 'Asia/Kolkata'),
    );
  });
});

describe('canonicalTz', () => {
  it('modernises the legacy id Chrome reports for India', () => {
    expect(canonicalTz('Asia/Calcutta')).toBe('Asia/Kolkata');
  });

  it('leaves a current name alone', () => {
    expect(canonicalTz('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(canonicalTz('America/New_York')).toBe('America/New_York');
  });
});

describe('isCalendarDate', () => {
  it('accepts a real calendar date', () => {
    expect(isCalendarDate('2026-10-01')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
  });

  it('rejects what a cleared or half-typed date field produces', () => {
    for (const bad of ['', '2026-10', '2026-1-1', '2026-13-01', '2026-10-32', 'today', null, undefined]) {
      expect(isCalendarDate(bad)).toBe(false);
    }
  });
});

describe('input contract', () => {
  // The regression: an empty value used to reach Intl and surface as
  // `RangeError: Invalid time value` four frames down, which on the Earnings
  // page took out the whole render. These must fail by name instead.
  it('names the offending value instead of failing inside Intl', () => {
    expect(() => boundsOfCalendarDateInTz('', 'Asia/Kolkata')).toThrow(
      /boundsOfCalendarDateInTz: expected a YYYY-MM-DD calendar date, got ""/,
    );
    expect(() => addCalendarDays('', -6)).toThrow(/addCalendarDays: expected a YYYY-MM-DD/);
    expect(() => rangeBoundsInTz('2026-10-01', '', 'UTC')).toThrow(/expected a YYYY-MM-DD/);
  });

  it('rejects a well-shaped but impossible date', () => {
    expect(() => boundsOfCalendarDateInTz('2026-02-30', 'UTC')).not.toThrow(); // Feb 30 rolls to Mar 2
    expect(() => boundsOfCalendarDateInTz('2026-13-01', 'UTC')).toThrow(/expected a YYYY-MM-DD/);
  });
});
