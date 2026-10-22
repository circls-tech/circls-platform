/**
 * Formatting for notification copy: money and dates, in the venue's time
 * zone. Pure functions — templates do no formatting of their own, so every
 * value arrives display-ready.
 */

/** "₹1,84,350", "₹798.50", "$1,200". INR groups the Indian way. */
export function formatMoney(minor: number, currency = 'INR'): string {
  const major = minor / 100;
  const whole = Number.isInteger(major);
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${currency} ${major.toFixed(whole ? 0 : 2)}`;
  }
}

export const DEFAULT_TZ = 'Asia/Kolkata';

interface DateParts {
  weekday: string;
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
  dayPeriod: string;
}

function parts(at: Date, tz: string): DateParts {
  const out: Record<string, string> = {};
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return parts(at, DEFAULT_TZ);
  }
  for (const p of fmt.formatToParts(at)) out[p.type] = p.value;
  return {
    weekday: out['weekday'] ?? '',
    day: out['day'] ?? '',
    month: out['month'] ?? '',
    year: out['year'] ?? '',
    hour: out['hour'] ?? '',
    minute: out['minute'] ?? '',
    dayPeriod: (out['dayPeriod'] ?? '').toUpperCase(),
  };
}

/** "Sat 4 Oct 2026". */
export function formatDayWithYear(at: Date, tz = DEFAULT_TZ): string {
  const p = parts(at, tz);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/**
 * "Sun 12 Oct, 6:00 AM", or a same-day range "Sat 4 Oct, 7:00–8:00 PM"
 * (the AM/PM shown once when both ends share it), or across days
 * "Sat 4 Oct, 11:00 PM – Sun 5 Oct, 1:00 AM".
 */
export function formatWhen(start: Date, end: Date | null = null, tz = DEFAULT_TZ): string {
  const s = parts(start, tz);
  const startTime = `${s.hour}:${s.minute}`;
  const day = `${s.weekday} ${s.day} ${s.month}`;
  if (!end) return `${day}, ${startTime} ${s.dayPeriod}`;
  const e = parts(end, tz);
  const endTime = `${e.hour}:${e.minute}`;
  const sameDay = s.day === e.day && s.month === e.month && s.year === e.year;
  if (sameDay) {
    return s.dayPeriod === e.dayPeriod
      ? `${day}, ${startTime}–${endTime} ${e.dayPeriod}`
      : `${day}, ${startTime} ${s.dayPeriod} – ${endTime} ${e.dayPeriod}`;
  }
  return `${day}, ${startTime} ${s.dayPeriod} – ${e.weekday} ${e.day} ${e.month}, ${endTime} ${e.dayPeriod}`;
}
