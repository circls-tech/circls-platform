import { Badge, type BadgeTone } from './Badge';

/**
 * Maps an entity lifecycle status (venues, arenas, events, memberships) to a
 * partner-friendly label + Badge tone. Subproject B added the `pending_review`
 * and `rejected` states (new listings now go to Circls for approval before they
 * become visible to consumers), so this is the single place the partner portal
 * translates raw status strings into something a partner can understand.
 *
 * Partners only VIEW status here — approving/rejecting is admin-only.
 */
const STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  pending_review: { label: 'Pending review', tone: 'warning' },
  active:         { label: 'Live',           tone: 'success' },
  published:      { label: 'Live',           tone: 'success' },
  rejected:       { label: 'Rejected',       tone: 'danger' },
  suspended:      { label: 'Suspended',      tone: 'danger' },
  inactive:       { label: 'Inactive',       tone: 'neutral' },
  draft:          { label: 'Draft',          tone: 'open' },
  cancelled:      { label: 'cancelled',      tone: 'neutral' },
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
