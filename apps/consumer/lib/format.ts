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

const timeFmt = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** Time portion of an ISO string, e.g. "6:30 PM". */
export function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso));
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
