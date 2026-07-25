// ──────────────────────────────────────────────────────────────────────────────
// Grid display helpers shared by the Matrix component (builder + reception).
//
// All functions accept a `dayStartMin` (business-day boundary). With the default
// of 0 they reproduce the original calendar-day behaviour exactly, so callers
// that don't opt in are unaffected.
// ──────────────────────────────────────────────────────────────────────────────

import { businessOffset, parseTimeToMin } from './bands';

/** "YYYY-MM-DD" calendar date of an instant in `tz`. */
function dateStrInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** "HH:mm" wall-clock label of an instant in `tz` (shared time-row key). */
export function fmtTimeKey(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * Day column index, as the REAL day difference between the slot's calendar
 * date (in `tz`) and `weekStart`'s local calendar date. With `dayStartMin > 0`
 * the instant is shifted back by that many minutes before its date is read, so
 * a post-midnight slot buckets into the business day that owns it (e.g. a 2am
 * slot → the previous day's column).
 *
 * The result is NOT wrapped mod 7: a slot outside the visible week returns a
 * negative index or one > 6 and must be dropped by the caller. (Bucketing by
 * weekday alone folded the reception view's ±1-day fetch padding onto the
 * visible columns — hidden other-week slots got selected and edited along with
 * the visible ones.)
 *
 * Relies on the venue tz being non-DST (the same assumption already documented
 * in the backend slot service).
 */
export function gridDayIndex(
  iso: string,
  tz: string,
  weekStart: Date,
  dayStartMin = 0,
): number {
  const shifted = new Date(new Date(iso).getTime() - dayStartMin * 60_000);
  const slotDate = dateStrInTz(shifted, tz);
  const wsDate = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;
  // Whole-day difference via UTC-noon anchors (immune to DST/offset wobble).
  return Math.round(
    (Date.parse(`${slotDate}T12:00:00Z`) - Date.parse(`${wsDate}T12:00:00Z`)) / 86_400_000,
  );
}

/**
 * Comparator for "HH:MM" time-row keys ordered by their position within the
 * business day. With `dayStartMin = 0` this is a plain numeric (== lexical)
 * order; with `dayStartMin = 180` rows read 03:00, 04:00, …, 23:00, 00:00, …, 02:00.
 */
export function compareTimeKeys(a: string, b: string, dayStartMin = 0): number {
  return businessOffset(parseTimeToMin(a), dayStartMin) - businessOffset(parseTimeToMin(b), dayStartMin);
}

/** Sort a list of "HH:MM" keys by business-day order (non-mutating). */
export function sortTimeKeys(keys: string[], dayStartMin = 0): string[] {
  return [...keys].sort((a, b) => compareTimeKeys(a, b, dayStartMin));
}
