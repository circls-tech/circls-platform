const rupeeFmt = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** Format paise as Indian rupees, e.g. 250000 → "₹2,500". Free → "Free". */
export function formatPaise(paise: number): string {
  if (!paise) return 'Free';
  return rupeeFmt.format(paise / 100);
}

const rupeeFmtExact = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format paise as rupees showing exact paise (2 decimals), e.g. 35847 → "₹358.47".
 * Use where sub-rupee amounts occur (checkout breakdown), since the Razorpay
 * gross-up produces fractional-rupee totals that the integer `formatPaise` would
 * truncate misleadingly. Free → "Free".
 */
export function formatPaiseExact(paise: number): string {
  if (!paise) return 'Free';
  return rupeeFmtExact.format(paise / 100);
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

const weekdayFmt = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long', day: 'numeric', month: 'short',
});

/** A day divider label, e.g. "Saturday, 14 Jun". */
export function formatDayLabel(iso: string): string {
  return weekdayFmt.format(new Date(iso));
}
