// ──────────────────────────────────────────────────────────────────────────────
// Pricing bands & business-day math for the schedule builder.
//
// Pure, framework-free, unit-tested. A "business day" need not align with the
// calendar day: it starts at `dayStartMin` (minute-of-day, e.g. 180 = 3am) and
// runs 1440 minutes. This lets a band like 4pm–2am read as one contiguous block
// instead of wrapping past calendar midnight, and lets a venue stay open 24h
// (a single band whose end equals its start).
// ──────────────────────────────────────────────────────────────────────────────

/** Minutes in a day. */
export const DAY_MIN = 1440;

/** A pricing band: a contiguous span of the business day at a single price. */
export interface Band {
  /** Start, minutes-from-midnight in venue wall-clock, 0..1439. */
  startMin: number;
  /** End, minutes-from-midnight in venue wall-clock, 0..1439.
   *  `endMin === startMin` denotes a full 24-hour band. */
  endMin: number;
  priceRupees: number;
}

/** A release cell as consumed by the slots/release API. */
export interface ReleaseCell {
  dayOfWeek: number;
  /** Minutes from the business day's local midnight; MAY exceed 1439 (overnight). */
  startTimeMin: number;
  durationMin: number;
  /** Paise. */
  price?: number | null;
  blocked?: boolean;
}

/** Parse 'HH:MM' → minutes from midnight, or NaN when malformed. */
export function parseTimeToMin(t: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

/** Format minutes (any integer; wraps mod 1440) → 'HH:MM'. */
export function minToTime(min: number): string {
  const m = (((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Position of wall-clock minute `t` within a business day starting at `dayStartMin`. 0..1439 */
export function businessOffset(t: number, dayStartMin: number): number {
  return (((t - dayStartMin) % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

export interface NormalizedBand {
  /** 0..1439 */
  startOffset: number;
  /** startOffset+1 .. startOffset+1440 (so endOffset > startOffset always). */
  endOffset: number;
  /** 1..1440 */
  lengthMin: number;
  priceRupees: number;
}

/**
 * Convert a band to business-day offsets. A band whose end is at or before its
 * start (in business-day offset terms) is treated as wrapping into the next
 * calendar day; `endMin === startMin` therefore yields a full 24-hour band.
 */
export function normalizeBand(band: Band, dayStartMin: number): NormalizedBand {
  const startOffset = businessOffset(band.startMin, dayStartMin);
  let endOffset = businessOffset(band.endMin, dayStartMin);
  if (endOffset <= startOffset) endOffset += DAY_MIN;
  return {
    startOffset,
    endOffset,
    lengthMin: endOffset - startOffset,
    priceRupees: band.priceRupees,
  };
}

export interface BandValidation {
  ok: boolean;
  error?: string;
}

/** Validate a set of bands against a business-day window. Gaps are allowed. */
export function validateBands(bands: Band[], dayStartMin: number): BandValidation {
  if (bands.length === 0) return { ok: false, error: 'Add at least one pricing band.' };

  for (const b of bands) {
    if (!Number.isFinite(b.startMin) || !Number.isFinite(b.endMin)) {
      return { ok: false, error: 'Each band needs a valid start and end time.' };
    }
    if (b.startMin < 0 || b.startMin > 1439 || b.endMin < 0 || b.endMin > 1439) {
      return { ok: false, error: 'Band times must fall within a day.' };
    }
    if (!Number.isFinite(b.priceRupees) || b.priceRupees < 0) {
      return { ok: false, error: 'Each band needs a valid non-negative price (₹).' };
    }
  }

  const norm = bands
    .map((b) => normalizeBand(b, dayStartMin))
    .sort((a, z) => a.startOffset - z.startOffset);

  // A 24-hour band fills the whole window; it cannot coexist with another band.
  if (norm.some((n) => n.lengthMin >= DAY_MIN) && norm.length > 1) {
    return { ok: false, error: 'A 24-hour band must be the only band.' };
  }

  // Adjacent bands must not overlap…
  for (let i = 1; i < norm.length; i++) {
    if (norm[i]!.startOffset < norm[i - 1]!.endOffset) {
      return { ok: false, error: 'Bands overlap. Adjust the times so they don’t overlap.' };
    }
  }
  // …and the last band (which may wrap past midnight) must not collide with the first.
  if (norm.length > 0 && norm[norm.length - 1]!.endOffset > norm[0]!.startOffset + DAY_MIN) {
    return { ok: false, error: 'Bands overlap. Adjust the times so they don’t overlap.' };
  }

  return { ok: true };
}

export interface ExpandOptions {
  bands: Band[];
  dayStartMin: number;
  quantizationMin: number;
}

/**
 * Expand bands into release cells for all 7 weekdays. Each band is sliced into
 * `quantizationMin`-long bookable slots (final slot clamped to the band end).
 * `startTimeMin` is kept LINEAR (may exceed 1439) so overnight slots anchor to
 * the weekday whose business day owns them.
 */
export function expandBandsToCells({ bands, dayStartMin, quantizationMin }: ExpandOptions): ReleaseCell[] {
  if (quantizationMin <= 0) return [];
  const norm = bands.map((b) => normalizeBand(b, dayStartMin));
  const cells: ReleaseCell[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (const n of norm) {
      for (let o = n.startOffset; o < n.endOffset; o += quantizationMin) {
        const step = Math.min(quantizationMin, n.endOffset - o);
        cells.push({
          dayOfWeek: dow,
          startTimeMin: dayStartMin + o,
          durationMin: step,
          price: Math.round(n.priceRupees * 100),
          blocked: false,
        });
      }
    }
  }
  return cells;
}
