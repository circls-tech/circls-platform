// ──────────────────────────────────────────────────────────────────────────────
// Grid display helpers shared by the Matrix component (builder + reception).
//
// All functions accept a `dayStartMin` (business-day boundary). With the default
// of 0 they reproduce the original calendar-day behaviour exactly, so callers
// that don't opt in are unaffected.
// ──────────────────────────────────────────────────────────────────────────────

import { businessOffset, parseTimeToMin } from './bands';

const WEEKDAY_ABBRS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Day-of-week column index (0..6, relative to `weekStart`) that a slot instant
 * belongs to. With `dayStartMin > 0` the instant is shifted back by that many
 * minutes before its weekday is read, so a post-midnight slot buckets into the
 * business day that owns it (e.g. a 2am slot → the previous day's column).
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
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).formatToParts(
    shifted,
  );
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const slotDow = WEEKDAY_ABBRS.indexOf(wd as (typeof WEEKDAY_ABBRS)[number]);
  if (slotDow < 0) return -1;
  const weekStartDow = weekStart.getDay();
  return (slotDow - weekStartDow + 7) % 7;
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
