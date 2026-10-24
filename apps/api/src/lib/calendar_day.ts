/**
 * Calendar days of instants in a zone. Formatters are cached per zone: they
 * are comparatively expensive to build, and list endpoints ask for the same
 * few zones once per row.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** 'YYYY-MM-DD' calendar date of an instant in `tz`. Throws a RangeError for
 *  an unknown zone (and caches nothing for it). */
export function dateStrInTz(at: Date | number, tz: string): string {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(tz, fmt);
  }
  return fmt.format(at);
}
