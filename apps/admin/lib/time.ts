/**
 * MIRROR OF apps/partners/lib/time.ts — KEEP THE TWO IN SYNC.
 *
 * The admin console's Earnings tab has to resolve a period to exactly the same
 * instants the partner's own Earnings page does, or the two will quote
 * different figures for the same week and an admin fielding "my payout looks
 * wrong" will be comparing against a number the partner never saw. That makes
 * the day-boundary maths a shared contract, not an implementation detail.
 *
 * It is copied rather than imported because `packages/` holds no shared
 * front-end package yet (see the README: the portals mirror types locally for
 * now). When one lands, this and its twin should move into it and this file
 * should go. Until then: fix a bug here and in the partners copy together.
 */
// ──────────────────────────────────────────────────────────────────────────────
// Timezone display utilities.
//
// These are PURE helpers for *displaying* instants in a chosen IANA timezone.
// The portal-wide "viewing timezone" lives in `timezone_context.tsx`; these
// functions take the resolved tz explicitly so they stay testable and usable
// outside React. Nothing here changes how times are stored or how events are
// scheduled — display only.
// ──────────────────────────────────────────────────────────────────────────────

/** Fallback tz used during SSR or when the runtime can't resolve one. */
export const FALLBACK_TZ = 'Asia/Kolkata';

/** A curated short-list of zones surfaced first in the picker. */
export const COMMON_TZS = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
] as const;

/** The viewer's browser timezone, or {@link FALLBACK_TZ} when unavailable. */
export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TZ;
  } catch {
    return FALLBACK_TZ;
  }
}

/**
 * Canonical IANA names for the legacy ids CLDR keeps alive for stability —
 * Chrome reports 'Asia/Calcutta' for India, so this is the common case in our
 * biggest market, not an edge one. Display-only here: it just keeps a stale
 * name off the screen.
 *
 * Mirrors LEGACY_TZ_ALIASES in apps/api/src/routes/activity.ts, which needs the
 * same mapping for a harder reason — Postgres rejects these names outright.
 * Keep the two lists in step.
 */
const LEGACY_TZ_ALIASES: Record<string, string> = {
  'Africa/Asmera': 'Africa/Asmara',
  'America/Godthab': 'America/Nuuk',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Macao': 'Asia/Macau',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

/** A timezone's modern name, for showing to someone. */
export function canonicalTz(tz: string): string {
  return LEGACY_TZ_ALIASES[tz] ?? tz;
}

/** A short GMT-offset label for a timezone, e.g. "GMT+5:30". */
export function fmtTzOffset(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** Full IANA timezone list when the runtime supports it, else a curated set. */
export function listTimezones(): string[] {
  const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
    .supportedValuesOf;
  if (typeof sv === 'function') {
    try {
      return sv('timeZone');
    } catch {
      /* fall through to curated list */
    }
  }
  return [...COMMON_TZS];
}

// ──────────────────────────────────────────────────────────────────────────────
// Calendar-day windows in a timezone.
//
// Turning "last 7 days" into the pair of UTC instants an API wants is the one
// piece of date maths in the portal that is easy to get subtly wrong, so it
// lives here once, with tests, rather than in each page that needs a range.
// ──────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD', with a real month and day — not just the right shape. */
const YMD = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * Whether `value` is a calendar date these helpers accept.
 *
 * Callers that take a date from a user — an `<input type="date">` can be
 * cleared to `''` — must check this before passing it on, and decide for
 * themselves what an empty field means. The helpers below cannot decide that:
 * substituting today would silently show figures for a period nobody asked
 * for, which on a money page is worse than refusing.
 */
export function isCalendarDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && YMD.test(value);
}

/**
 * Guard the helpers' precondition with a message that names the culprit.
 *
 * Without this, a malformed date fails as `RangeError: Invalid time value`
 * raised inside `Intl.DateTimeFormat.formatToParts`, four frames down from the
 * call that actually went wrong and with no mention of the offending value.
 */
function assertCalendarDate(ymd: string, fn: string): void {
  if (!isCalendarDate(ymd)) {
    throw new RangeError(`${fn}: expected a YYYY-MM-DD calendar date, got ${JSON.stringify(ymd)}`);
  }
}

/** The calendar date a instant falls on in `tz`, as 'YYYY-MM-DD'. */
export function calendarDateInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Shift a 'YYYY-MM-DD' calendar date by whole days, staying on the calendar.
 *
 * Done in UTC on a date-only value, so it never touches a timezone and never
 * trips over a DST day being 23 or 25 hours long — "7 days ago" means seven
 * calendar days ago whatever the clocks did in between.
 */
export function addCalendarDays(ymd: string, days: number): string {
  assertCalendarDate(ymd, 'addCalendarDays');
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The wall-clock offset `tz` is on at a given instant, in ms (east of UTC is
 * positive). Read from `Intl`, so it is right for half-hour zones, for
 * historical rule changes, and for whichever side of a DST change the instant
 * sits on.
 */
function tzOffsetMsAt(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hourCycle: h23` is not portable, so 24 can come back for midnight.
  const hour = get('hour') % 24;
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asIfUtc - utcMs;
}

/**
 * The UTC instant at which `tz`'s wall clock reads midnight on `ymd`.
 *
 * Two passes: guess by treating the wall clock as UTC, correct by the offset in
 * force at that guess, then re-measure at the candidate and correct again. The
 * second pass is what makes a date whose guess lands on the far side of a DST
 * change come out right; a third would never differ, since two transitions
 * cannot fall within one day.
 *
 * An earlier version of this sampled the offset only at 00:00 UTC on the date
 * and subtracted it. That is correct for zones east of UTC but a full day out
 * for zones west of it, where 00:00 UTC is still the *previous* evening — so a
 * US venue's "today" resolved to yesterday.
 */
function startOfCalendarDateInTz(ymd: string, tz: string): number {
  assertCalendarDate(ymd, 'boundsOfCalendarDateInTz');
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const wallAsUtc = Date.UTC(y, m - 1, d);
  const firstPass = wallAsUtc - tzOffsetMsAt(wallAsUtc, tz);
  return wallAsUtc - tzOffsetMsAt(firstPass, tz);
}

/**
 * The UTC instants bounding a 'YYYY-MM-DD' calendar date in `tz`:
 * `[midnight, next midnight)`.
 *
 * `to` is the *next date's* midnight rather than `from + 24h`, because a day
 * that spans a DST change is 23 or 25 hours long.
 */
export function boundsOfCalendarDateInTz(ymd: string, tz: string): { from: string; to: string } {
  return {
    from: new Date(startOfCalendarDateInTz(ymd, tz)).toISOString(),
    to: new Date(startOfCalendarDateInTz(addCalendarDays(ymd, 1), tz)).toISOString(),
  };
}

/**
 * The UTC instants bounding one day in `tz` — `'today'`, or the calendar day
 * some instant falls on there.
 */
export function dayBoundsInTz(date: Date | 'today', tz: string): { from: string; to: string } {
  return boundsOfCalendarDateInTz(calendarDateInTz(date === 'today' ? new Date() : date, tz), tz);
}

/**
 * The UTC instants spanning a closed range of calendar dates in `tz`:
 * from the first date's midnight to the last date's *next* midnight, so the
 * last day is whole. Bounds given out of order are swapped rather than
 * returning an empty window.
 */
export function rangeBoundsInTz(
  fromYmd: string,
  toYmd: string,
  tz: string,
): { from: string; to: string } {
  const [lo, hi] = fromYmd <= toYmd ? [fromYmd, toYmd] : [toYmd, fromYmd];
  return {
    from: boundsOfCalendarDateInTz(lo, tz).from,
    to: boundsOfCalendarDateInTz(hi, tz).to,
  };
}
