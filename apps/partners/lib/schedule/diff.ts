// ──────────────────────────────────────────────────────────────────────────────
// Planned-changes preview for the schedule builder.
//
// Compares the builder's plan (release cells) against the arena's existing
// FUTURE slots in the selected date range, in the same way the API reconciles
// on release: booked/held slots are always kept, matching non-booked slots are
// repriced / (un)blocked, and non-booked slots that no longer fit the plan are
// removed. Pure and unit-tested; the numbers shown after an actual release come
// from the API and are authoritative.
// ──────────────────────────────────────────────────────────────────────────────

import { DAY_MIN, parseTimeToMin, type ReleaseCell } from './bands';
import { fmtTimeKey } from './grid';

export interface PlannedPriceChange {
  fromPaise: number;
  toPaise: number;
  count: number;
}

export interface PlannedChanges {
  created: number;
  repriced: number;
  blocked: number;
  unblocked: number;
  removed: number;
  unchanged: number;
  keptBooked: number;
  priceChanges: PlannedPriceChange[];
}

/** The subset of a Slot the diff needs. */
export interface ExistingSlotLike {
  startAt: string;
  endAt: string;
  pricePaise: number;
  status: 'open' | 'held' | 'blocked' | 'booked';
}

const WEEKDAY_ABBRS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Weekday (0=Sun..6) of the business day owning `iso`, in venue tz. */
function businessDow(iso: string, tz: string, dayStartMin: number): number {
  const shifted = new Date(new Date(iso).getTime() - dayStartMin * 60_000);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(shifted);
  return WEEKDAY_ABBRS.indexOf(wd);
}

/** Pattern key a slot / cell occupies: business weekday + wall-clock start + length. */
function patternKey(dow: number, wallStartMin: number, durationMin: number): string {
  return `${dow}-${wallStartMin}-${durationMin}`;
}

/**
 * Count, per weekday (0=Sun..6), the dates in [startDate, endDate] inclusive,
 * ignoring dates before `minDate` (both 'YYYY-MM-DD'). Capped at 1000 days.
 */
export function weekdayCounts(startDate: string, endDate: string, minDate?: string): number[] {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return counts;
  const d = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  for (let i = 0; i < 1000 && d.getTime() <= end.getTime(); i++, d.setDate(d.getDate() + 1)) {
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!minDate || ds >= minDate) counts[d.getDay()]!++;
  }
  return counts;
}

export interface DiffOptions {
  /** Venue IANA tz — the tz the plan's cell minutes are expressed in. */
  tz: string;
  dayStartMin: number;
  startDate: string; // 'YYYY-MM-DD'
  endDate: string; // 'YYYY-MM-DD'
  /** Local 'YYYY-MM-DD' — dates before this don't count toward `created`. */
  todayDate?: string;
}

/**
 * Diff the plan against the arena's existing future slots for the range.
 * `existing` must already be filtered to future slots within the released
 * business days. `created` is an estimate (per-weekday date counts minus
 * matched existing slots); everything else is counted per real slot.
 */
export function diffPlannedCells(
  cells: ReleaseCell[],
  existing: ExistingSlotLike[],
  opts: DiffOptions,
): PlannedChanges {
  const out: PlannedChanges = {
    created: 0,
    repriced: 0,
    blocked: 0,
    unblocked: 0,
    removed: 0,
    unchanged: 0,
    keptBooked: 0,
    priceChanges: [],
  };

  const byKey = new Map<string, ReleaseCell>();
  for (const c of cells) {
    const wallStart = ((c.startTimeMin % DAY_MIN) + DAY_MIN) % DAY_MIN;
    byKey.set(patternKey(c.dayOfWeek, wallStart, c.durationMin), c);
  }

  const priceChangeMap = new Map<string, PlannedPriceChange>();
  let matchedExisting = 0;

  for (const s of existing) {
    const dow = businessDow(s.startAt, opts.tz, opts.dayStartMin);
    const wallStart = parseTimeToMin(fmtTimeKey(s.startAt, opts.tz));
    const durationMin = Math.round((Date.parse(s.endAt) - Date.parse(s.startAt)) / 60_000);
    const cell = byKey.get(patternKey(dow, wallStart, durationMin));
    const isLocked = s.status === 'booked' || s.status === 'held';

    if (!cell) {
      if (isLocked) out.keptBooked++;
      else out.removed++;
      continue;
    }
    matchedExisting++;
    if (isLocked) {
      out.keptBooked++;
      continue;
    }

    const priceDiff = cell.price != null && cell.price !== s.pricePaise;
    const desiredBlocked = cell.blocked ?? false;
    const statusDiff = desiredBlocked !== (s.status === 'blocked');
    if (!priceDiff && !statusDiff) {
      out.unchanged++;
      continue;
    }
    if (priceDiff) {
      out.repriced++;
      const key = `${s.pricePaise}->${cell.price}`;
      const bucket = priceChangeMap.get(key) ?? {
        fromPaise: s.pricePaise,
        toPaise: cell.price!,
        count: 0,
      };
      bucket.count++;
      priceChangeMap.set(key, bucket);
    }
    if (statusDiff) {
      if (desiredBlocked) out.blocked++;
      else out.unblocked++;
    }
  }

  const wd = weekdayCounts(opts.startDate, opts.endDate, opts.todayDate);
  let planned = 0;
  for (const c of cells) planned += wd[c.dayOfWeek] ?? 0;
  out.created = Math.max(0, planned - matchedExisting);

  out.priceChanges = [...priceChangeMap.values()].sort((a, b) => b.count - a.count);
  return out;
}
