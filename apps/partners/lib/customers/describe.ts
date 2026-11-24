import type { CustomerKind, CustomerSuggestion } from '@/lib/api/customers';

/** Singular and plural, in the order they're listed. */
const KIND_LABEL: [CustomerKind, string, string][] = [
  ['slot', 'court booking', 'court bookings'],
  ['event', 'event', 'events'],
  ['membership', 'membership', 'memberships'],
];

/**
 * The one-line history under a suggested customer: how often they've been
 * here and for what — "3 visits · court bookings, events", "1 visit ·
 * membership". Kinds come out in a fixed order so the same person reads the
 * same way every time.
 */
export function describeCustomer(c: Pick<CustomerSuggestion, 'timesSeen' | 'kinds'>): string {
  const one = c.timesSeen === 1;
  const visits = `${c.timesSeen} visit${one ? '' : 's'}`;
  const kinds = KIND_LABEL.filter(([k]) => c.kinds.includes(k)).map(([, singular, plural]) =>
    one ? singular : plural,
  );
  return kinds.length > 0 ? `${visits} · ${kinds.join(', ')}` : visits;
}

/**
 * "Last seen 12 Nov 2026" in the given zone. A date, not a time: the hint
 * says roughly when, not exactly.
 */
export function lastSeenLabel(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `Last seen ${new Intl.DateTimeFormat('en-IN', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d)}`;
}
