import { describe, expect, it } from 'vitest';
import {
  type Band,
  businessOffset,
  expandBandsToCells,
  minToTime,
  normalizeBand,
  parseTimeToMin,
  validateBands,
} from './bands';

const DAY_START = 180; // 3am

describe('parseTimeToMin / minToTime', () => {
  it('parses HH:MM', () => {
    expect(parseTimeToMin('00:00')).toBe(0);
    expect(parseTimeToMin('06:00')).toBe(360);
    expect(parseTimeToMin('23:59')).toBe(1439);
  });
  it('returns NaN for malformed input', () => {
    expect(parseTimeToMin('')).toBeNaN();
    expect(parseTimeToMin('25:00')).toBeNaN();
    expect(parseTimeToMin('12:60')).toBeNaN();
  });
  it('formats minutes, wrapping past a day', () => {
    expect(minToTime(0)).toBe('00:00');
    expect(minToTime(360)).toBe('06:00');
    expect(minToTime(1500)).toBe('01:00'); // 25:00 wraps to 01:00
  });
});

describe('businessOffset', () => {
  it('places times relative to the business-day start', () => {
    expect(businessOffset(180, DAY_START)).toBe(0); // 3am = start
    expect(businessOffset(360, DAY_START)).toBe(180); // 6am
    expect(businessOffset(120, DAY_START)).toBe(1380); // 2am = late in the day
  });
});

describe('normalizeBand', () => {
  it('handles a normal daytime band', () => {
    const n = normalizeBand({ startMin: 360, endMin: 600, priceRupees: 400 }, DAY_START);
    expect(n.startOffset).toBe(180);
    expect(n.endOffset).toBe(420);
    expect(n.lengthMin).toBe(240);
  });
  it('handles a band that wraps past midnight (4pm–2am)', () => {
    const n = normalizeBand({ startMin: 960, endMin: 120, priceRupees: 800 }, DAY_START);
    expect(n.startOffset).toBe(780); // 4pm
    expect(n.endOffset).toBe(1380); // 2am
    expect(n.lengthMin).toBe(600); // 10h
  });
  it('treats end === start as a full 24-hour band', () => {
    const n = normalizeBand({ startMin: 180, endMin: 180, priceRupees: 500 }, DAY_START);
    expect(n.startOffset).toBe(0);
    expect(n.endOffset).toBe(1440);
    expect(n.lengthMin).toBe(1440);
  });
});

describe('validateBands', () => {
  const ok = (bands: Band[]) => validateBands(bands, DAY_START).ok;

  it('accepts three contiguous bands incl. an overnight one', () => {
    expect(
      ok([
        { startMin: 360, endMin: 600, priceRupees: 400 }, // 6–10am
        { startMin: 600, endMin: 960, priceRupees: 600 }, // 10am–4pm
        { startMin: 960, endMin: 120, priceRupees: 800 }, // 4pm–2am
      ]),
    ).toBe(true);
  });

  it('accepts a single 24-hour band', () => {
    expect(ok([{ startMin: 180, endMin: 180, priceRupees: 500 }])).toBe(true);
  });

  it('rejects a 24-hour band alongside another', () => {
    const r = validateBands(
      [
        { startMin: 180, endMin: 180, priceRupees: 500 },
        { startMin: 360, endMin: 600, priceRupees: 400 },
      ],
      DAY_START,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects overlapping bands', () => {
    expect(
      ok([
        { startMin: 360, endMin: 660, priceRupees: 400 }, // 6–11am
        { startMin: 600, endMin: 960, priceRupees: 600 }, // 10am–4pm (overlaps)
      ]),
    ).toBe(false);
  });

  it('rejects an overnight band that wraps into the first band', () => {
    // 4pm–4am wraps to offset 60, colliding with the 6am (offset 180)… actually
    // collides with an early band starting at 3:30am (offset 30).
    expect(
      ok([
        { startMin: 210, endMin: 300, priceRupees: 300 }, // 3:30–5am (offset 30–120)
        { startMin: 960, endMin: 240, priceRupees: 800 }, // 4pm–4am (offset 780–1500) wraps to 60
      ]),
    ).toBe(false);
  });

  it('allows gaps between bands', () => {
    expect(
      ok([
        { startMin: 360, endMin: 600, priceRupees: 400 }, // 6–10am
        { startMin: 720, endMin: 960, priceRupees: 600 }, // 12–4pm (gap 10am–12pm)
      ]),
    ).toBe(true);
  });

  it('rejects empty band sets and bad prices', () => {
    expect(ok([])).toBe(false);
    expect(ok([{ startMin: 360, endMin: 600, priceRupees: -1 }])).toBe(false);
  });
});

describe('expandBandsToCells', () => {
  it('slices a band into quantized cells across all 7 days', () => {
    const cells = expandBandsToCells({
      bands: [{ startMin: 360, endMin: 600, priceRupees: 400 }], // 6–10am, 240 min
      dayStartMin: DAY_START,
      quantizationMin: 60,
    });
    // 240/60 = 4 slots × 7 days
    expect(cells.length).toBe(28);
    const day0 = cells.filter((c) => c.dayOfWeek === 0);
    expect(day0.map((c) => c.startTimeMin)).toEqual([360, 420, 480, 540]);
    expect(day0.every((c) => c.durationMin === 60)).toBe(true);
    expect(day0.every((c) => c.price === 40000)).toBe(true);
  });

  it('emits linear (>1439) startTimeMin for overnight slots', () => {
    const cells = expandBandsToCells({
      bands: [{ startMin: 960, endMin: 120, priceRupees: 800 }], // 4pm–2am
      dayStartMin: DAY_START,
      quantizationMin: 60,
    });
    const day1 = cells.filter((c) => c.dayOfWeek === 1).map((c) => c.startTimeMin);
    // 4pm (960) … last slot starts 1am next day (1500), all anchored to day 1.
    expect(day1[0]).toBe(960);
    expect(day1[day1.length - 1]).toBe(1500);
    expect(day1.some((m) => m >= 1440)).toBe(true);
  });

  it('clamps the final partial slot to the band end', () => {
    const cells = expandBandsToCells({
      bands: [{ startMin: 360, endMin: 510, priceRupees: 400 }], // 6:00–8:30, 150 min
      dayStartMin: DAY_START,
      quantizationMin: 60,
    });
    const day0 = cells.filter((c) => c.dayOfWeek === 0);
    expect(day0.map((c) => c.durationMin)).toEqual([60, 60, 30]); // last clamped
  });

  it('produces a single 1440-min span (quantized) for a 24h band', () => {
    const cells = expandBandsToCells({
      bands: [{ startMin: 180, endMin: 180, priceRupees: 500 }],
      dayStartMin: DAY_START,
      quantizationMin: 60,
    });
    const day0 = cells.filter((c) => c.dayOfWeek === 0);
    expect(day0.length).toBe(24); // 1440/60
    expect(day0[0]!.startTimeMin).toBe(180); // starts at 3am
    expect(day0[day0.length - 1]!.startTimeMin).toBe(180 + 1380); // last slot 2am next day
  });
});
