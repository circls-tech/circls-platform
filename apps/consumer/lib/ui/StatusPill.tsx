import { Badge, type BadgeTone } from './Badge';

/**
 * Maps an entity lifecycle status (venues, arenas, events, memberships) OR a
 * booking status (pending / confirmed / completed / no_show / cancelled) to a
 * consumer-friendly label + Badge tone. This is the single place the consumer
 * portal translates raw status strings into something a customer can understand.
 */
const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  pending_review: { label: 'Pending review', tone: 'warning' },
  active:         { label: 'Live',           tone: 'success' },
  published:      { label: 'Live',           tone: 'success' },
  rejected:       { label: 'Rejected',       tone: 'danger' },
  suspended:      { label: 'Suspended',      tone: 'danger' },
  inactive:       { label: 'Inactive',       tone: 'neutral' },
  draft:          { label: 'Draft',          tone: 'open' },
  // Booking statuses (consumer "My bookings").
  pending:        { label: 'Pending',        tone: 'warning' },
  confirmed:      { label: 'Confirmed',      tone: 'success' },
  completed:      { label: 'Completed',      tone: 'booked' },
  no_show:        { label: 'No-show',        tone: 'danger' },
  cancelled:      { label: 'Cancelled',      tone: 'neutral' },
};

export interface StatusPillProps {
  status: string;
  className?: string;
}

/** Small status badge for a listing (venue / arena / event / membership). */
export function StatusPill({ status, className }: StatusPillProps) {
  const meta = STATUS_META[status] ?? { label: status, tone: 'neutral' as BadgeTone };
  return <Badge tone={meta.tone} label={meta.label} className={className} />;
}
