import { describe, expect, it } from 'vitest';
import type { ReleaseCell } from './bands';
import { diffPlannedCells, weekdayCounts, type ExistingSlotLike } from './diff';

const TZ = 'Asia/Kolkata';

// 2032-03-06 is a Saturday. 10:00 IST = 04:30Z.
function slot(
  startZ: string,
  endZ: string,
  pricePaise: number,
  status: ExistingSlotLike['status'],
): ExistingSlotLike {
  return { startAt: startZ, endAt: endZ, pricePaise, status };
}

describe('weekdayCounts', () => {
  it('counts each weekday once across a 7-day range', () => {
    expect(weekdayCounts('2032-03-06', '2032-03-12')).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('counts Saturdays twice across a 2-week range', () => {
    const counts = weekdayCounts('2032-03-01', '2032-03-14');
    expect(counts[6]).toBe(2); // 2032-03-06 and 2032-03-13
  });

  it('ignores dates before minDate', () => {
    expect(weekdayCounts('2032-03-06', '2032-03-12', '2032-03-08')).toEqual([
      0, 1, 1, 1, 1, 1, 0,
    ]);
  });

  it('returns zeros for malformed dates', () => {
    expect(weekdayCounts('garbage', '2032-03-12')).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('diffPlannedCells', () => {
  const opts = { tz: TZ, dayStartMin: 180, startDate: '2032-03-06', endDate: '2032-03-06' };

  it('classifies repriced / keptBooked / removed / unchanged', () => {
    const cells: ReleaseCell[] = [
      { dayOfWeek: 6, startTimeMin: 600, durationMin: 60, price: 20000 }, // 10:00, reprice
      { dayOfWeek: 6, startTimeMin: 660, durationMin: 60, price: 20000 }, // 11:00, booked
      { dayOfWeek: 6, startTimeMin: 780, durationMin: 60, price: 20000 }, // 13:00, unchanged
    ];
    const existing: ExistingSlotLike[] = [
      slot('2032-03-06T04:30:00.000Z', '2032-03-06T05:30:00.000Z', 10000, 'open'), // 10:00
      slot('2032-03-06T05:30:00.000Z', '2032-03-06T06:30:00.000Z', 10000, 'booked'), // 11:00
      slot('2032-03-06T06:30:00.000Z', '2032-03-06T07:30:00.000Z', 10000, 'open'), // 12:00 — stale
      slot('2032-03-06T07:30:00.000Z', '2032-03-06T08:30:00.000Z', 20000, 'open'), // 13:00
    ];

    const d = diffPlannedCells(cells, existing, opts);
    expect(d.repriced).toBe(1);
    expect(d.priceChanges).toEqual([{ fromPaise: 10000, toPaise: 20000, count: 1 }]);
    expect(d.keptBooked).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.unchanged).toBe(1);
    // 3 planned Saturday occurrences − 3 matched existing = 0 new.
    expect(d.created).toBe(0);
    expect(d.blocked).toBe(0);
    expect(d.unblocked).toBe(0);
  });

  it('counts block / unblock flips', () => {
    const cells: ReleaseCell[] = [
      { dayOfWeek: 6, startTimeMin: 600, durationMin: 60, price: 10000, blocked: true },
      { dayOfWeek: 6, startTimeMin: 660, durationMin: 60, price: 10000, blocked: false },
    ];
    const existing: ExistingSlotLike[] = [
      slot('2032-03-06T04:30:00.000Z', '2032-03-06T05:30:00.000Z', 10000, 'open'),
      slot('2032-03-06T05:30:00.000Z', '2032-03-06T06:30:00.000Z', 10000, 'blocked'),
    ];

    const d = diffPlannedCells(cells, existing, opts);
    expect(d.blocked).toBe(1);
    expect(d.unblocked).toBe(1);
    expect(d.repriced).toBe(0);
  });

  it('matches an overnight cell (startTimeMin ≥ 1440) to its next-calendar-day slot', () => {
    // Sat business day, 01:00 slot lands on Sunday 2032-03-07 01:00 IST = 03-06T19:30Z.
    const cells: ReleaseCell[] = [
      { dayOfWeek: 6, startTimeMin: 1500, durationMin: 60, price: 30000 },
    ];
    const existing: ExistingSlotLike[] = [
      slot('2032-03-06T19:30:00.000Z', '2032-03-06T20:30:00.000Z', 10000, 'open'),
    ];

    const d = diffPlannedCells(cells, existing, opts);
    expect(d.repriced).toBe(1);
    expect(d.removed).toBe(0);
    expect(d.created).toBe(0);
  });

  it('estimates created for plan positions with no existing slot', () => {
    const cells: ReleaseCell[] = [
      { dayOfWeek: 6, startTimeMin: 600, durationMin: 60, price: 10000 },
      { dayOfWeek: 0, startTimeMin: 600, durationMin: 60, price: 10000 },
    ];
    // One Saturday and one Sunday in range 2032-03-06..07; no existing slots.
    const d = diffPlannedCells(cells, [], { ...opts, endDate: '2032-03-07' });
    expect(d.created).toBe(2);
  });
});
