/**
 * Prices are stored in minor units (paise for INR, cents for USD — the `*Paise`
 * field names predate multi-currency) and are denominated by the venue's
 * country, mirroring the API's gateway rule (apps/api/src/lib/gateway.ts):
 * USA venues settle in USD, everything else in INR.
 */
export type CurrencyCode = 'INR' | 'USD';

/** Currency for a venue/org country as it appears in address payloads
 *  (canonically 'India' | 'USA'); null/unknown falls back to INR. */
export function currencyForCountry(country: string | null | undefined): CurrencyCode {
  const c = (country ?? '').trim().toLowerCase();
  return c === 'usa' || c === 'us' || c === 'united states' ? 'USD' : 'INR';
}

/** Pull the country out of a freeform addressJson blob (e.g. an event's
 *  resolved location) for currencyForCountry. */
export function countryOfAddress(address: Record<string, unknown> | null | undefined): string | null {
  const c = address?.country;
  return typeof c === 'string' ? c : null;
}

const moneyFmtCache = new Map<string, Intl.NumberFormat>();
// `currency` is a plain string so server-provided codes (quote/booking
// responses) plug in directly; unknown codes still render via Intl.
// NOTE: the `/100` minor-unit conversion assumes 2-decimal currencies (true
// for INR and USD — everything the platform charges in). Adding a zero-decimal
// currency (JPY, KRW) requires a per-currency divisor first.
function moneyFmt(currency: string, decimals: number): Intl.NumberFormat {
  const key = `${currency}:${decimals}`;
  let f = moneyFmtCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    moneyFmtCache.set(key, f);
  }
  return f;
}

/** Format minor units as whole currency, e.g. 250000 → "₹2,500" / "$2,500". Free → "Free". */
export function formatPaise(paise: number, currency: string = 'INR'): string {
  if (!paise) return 'Free';
  return moneyFmt(currency, 0).format(paise / 100);
}

/**
 * Format minor units showing exact sub-unit amounts (2 decimals), e.g.
 * 35847 → "₹358.47". Use where fractional amounts occur (checkout breakdown),
 * since the gateway gross-up produces fractional totals that the integer
 * `formatPaise` would truncate misleadingly. Free → "Free".
 */
export function formatPaiseExact(paise: number, currency: string = 'INR'): string {
  if (!paise) return 'Free';
  return moneyFmt(currency, 2).format(paise / 100);
}

const timeFmt = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** Time portion of an ISO string, e.g. "6:30 PM". */
export function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

/** Hour:minute in 12-hour form without the meridiem, e.g. "9:30", "12:00". */
function hourMinute(d: Date): string {
  const h = d.getHours() % 12 || 12;
  return `${h}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** am/pm for a local time. */
function meridiem(d: Date): 'am' | 'pm' {
  return d.getHours() < 12 ? 'am' : 'pm';
}

/**
 * Compact start–end range that collapses a shared meridiem so it fits a narrow
 * (e.g. 2-column mobile) slot chip on one line:
 *   same half-day  → "9:30 – 10:00 am"
 *   crossing noon  → "11:30 am – 12:00 pm"
 */
export function formatSlotRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sm = meridiem(start);
  const em = meridiem(end);
  return sm === em
    ? `${hourMinute(start)} – ${hourMinute(end)} ${em}`
    : `${hourMinute(start)} ${sm} – ${hourMinute(end)} ${em}`;
}

const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** Date + time, e.g. "12 Jun, 6:30 PM". */
export function formatDateTime(iso: string): string {
  return dateTimeFmt.format(new Date(iso));
}

const dateFmt = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Date only, e.g. "12 Jun 2026". */
export function formatDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

const dayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('en-IN', { month: 'short' });

/** Split an ISO date into a date-badge pair, e.g. { day: "14", month: "Jun" }. */
export function formatDayMonth(iso: string): { day: string; month: string } {
  const d = new Date(iso);
  return { day: dayFmt.format(d), month: monthFmt.format(d) };
}

/** Compact "time ago" for activity rows, e.g. "just now", "5m ago", "3h ago",
 *  "2d ago"; beyond a week it falls back to the plain date. */
export function formatRelativeTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

const weekdayFmt = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long', day: 'numeric', month: 'short',
});

/** A day divider label, e.g. "Saturday, 14 Jun". */
export function formatDayLabel(iso: string): string {
  return weekdayFmt.format(new Date(iso));
}

/** A dialable tel: URI from a display phone number — RFC 3966 allows only
 *  digits and a leading +, so "(617) 555-0142" → "tel:6175550142". */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, '')}`;
}
