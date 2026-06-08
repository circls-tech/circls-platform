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
