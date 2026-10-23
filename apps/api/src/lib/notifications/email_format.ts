/**
 * Formatting for notification copy: money, dates, short references, names.
 * Pure functions — the email templates do no formatting of their own (MSG91
 * renders them with no helpers), so every value arrives display-ready.
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

/** Sum of several currencies: "₹1,84,350 · $1,200". */
export function formatMoneyList(list: Array<{ currency: string; minor: number }>): string {
  if (list.length === 0) return formatMoney(0);
  return list.map((m) => formatMoney(m.minor, m.currency)).join(' · ');
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

/** "Sat 4 Oct" in the given time zone. */
export function formatDay(at: Date, tz = DEFAULT_TZ): string {
  const p = parts(at, tz);
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** "Sat 4 Oct 2026". */
export function formatDayWithYear(at: Date, tz = DEFAULT_TZ): string {
  const p = parts(at, tz);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/** "4 Oct" — for ranges like a payout cycle. */
export function formatDayMonth(at: Date, tz = DEFAULT_TZ): string {
  const p = parts(at, tz);
  return `${p.day} ${p.month}`;
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

/**
 * A short, readable reference for a record id: "BK-8F2K-9QD4". Built from the
 * last 8 hex digits of the UUID — the random part of a v7 id (the first ones
 * are a timestamp, shared by records created around the same moment) — so it
 * also matches the tail of the full id the app shows as the booking reference.
 */
export function shortRef(prefix: string, id: string): string {
  const tail = id.replace(/-/g, '').slice(-8).toUpperCase();
  return `${prefix}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}

/** First word of a display name, or a friendly fallback. */
export function firstName(name: string | null | undefined, fallback = 'there'): string {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : fallback;
}

/** "Rohan Mehta" → "Rohan M."; a single word stays as it is. */
export function shortName(name: string | null | undefined, fallback = 'A customer'): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return fallback;
  if (words.length === 1) return words[0]!;
  return `${words[0]} ${words[words.length - 1]![0]!.toUpperCase()}.`;
}

/** "19 hours", "3 days", "40 minutes" — how long something has waited. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/** "1 ticket" / "2 tickets". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Split a reviewer's free-text reason into bullet points: one per line or
 *  per semicolon (the admin portal's reject box is a single line, so it asks
 *  for fixes separated by ";"), with list markers ("-", "•", "1.") stripped.
 *  A single sentence stays one bullet. */
export function toBullets(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n|;/)
    .map((l) => l.replace(/^\s*(?:[-*•●]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 0);
}
