'use client';

import { useState } from 'react';
import {
  useAdminTenantEvents,
  useAdminTenantMemberships,
  useAdminTenantVenues,
} from '@/lib/api/queries';
import type {
  AdminTenantEventBillingItem,
  AdminTenantEventScope,
  AdminTenantMembershipItem,
  AdminTenantMembershipShelf,
  AdminTenantVenueItem,
  AdminTenantVenueShelf,
} from '@/lib/api/types';
import { formatPrice } from '@/lib/money';

/**
 * The tenant page's Venues, Events and Memberships tabs: read-only mirrors of
 * the partner portal's three listings, split into the same shelves the partner
 * sees so an admin looking at a support ticket sees what the partner sees.
 */

const IST_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return IST_DATE.format(new Date(iso));
}

/** An event time in the event's own zone, the way the partner portal shows it. */
function fmtEventTime(iso: string | null, tz: string | null): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: tz ?? 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    // An unknown IANA name on a legacy row: fall back rather than blank the cell.
    return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );
  }
}

/** "3 tiers · ₹500–₹2,000", as on the partner portal's memberships list. */
function tiersSummary(m: AdminTenantMembershipItem): string {
  const range =
    m.minPricePaise === m.maxPricePaise
      ? formatPrice(m.minPricePaise, m.currency)
      : `${formatPrice(m.minPricePaise, m.currency)}–${formatPrice(m.maxPricePaise, m.currency)}`;
  if (m.tierCount === 0) return range;
  return `${m.tierCount} tier${m.tierCount === 1 ? '' : 's'} · ${range}`;
}

// ── Shared bits ───────────────────────────────────────────────────────────────

/** Same wording and tones as the partner portal's StatusPill. */
const STATUS_META: Record<string, { label: string; tone: string }> = {
  pending_review: { label: 'Pending review', tone: 'bg-amber-100 text-amber-800' },
  active: { label: 'Live', tone: 'bg-emerald-100 text-emerald-800' },
  published: { label: 'Live', tone: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'Rejected', tone: 'bg-rose-100 text-rose-800' },
  suspended: { label: 'Suspended', tone: 'bg-rose-100 text-rose-800' },
  inactive: { label: 'Inactive', tone: 'bg-slate-100 text-slate-700' },
  draft: { label: 'Draft', tone: 'bg-sky-100 text-sky-800' },
  cancelled: { label: 'Cancelled', tone: 'bg-slate-100 text-slate-700' },
  completed: { label: 'Ended', tone: 'bg-slate-100 text-slate-700' },
};

function ListingStatusPill({ status, label }: { status: string; label?: string }) {
  const meta = STATUS_META[status] ?? { label: status, tone: 'bg-slate-100 text-slate-700' };
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${meta.tone}`}
    >
      {label ?? meta.label}
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-600">
      {children}
    </span>
  );
}

/** A shelf switcher: one of a few mutually exclusive views of a listing. */
export function ShelfTabs<K extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: K;
  onChange: (k: K) => void;
  options: { key: K; label: string }[];
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          onClick={() => onChange(o.key)}
          className={
            value === o.key
              ? 'rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white'
              : 'rounded-md border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50'
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 font-medium">{children}</th>;
}

function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

const THEAD_CLASS =
  'border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500';

// ── Venues ────────────────────────────────────────────────────────────────────

const VENUE_SHELVES: { key: AdminTenantVenueShelf; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'closed', label: 'Closed & rejected' },
  { key: 'all', label: 'All' },
];

export function VenuesTab({ tenantId }: { tenantId: string }) {
  const [shelf, setShelf] = useState<AdminTenantVenueShelf>('active');
  const { data, isLoading, isError, error } = useAdminTenantVenues(tenantId, shelf);
  const rows: AdminTenantVenueItem[] = data ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          {shelf === 'active'
            ? 'Live venues and ones awaiting review — what the partner sees on their Active tab.'
            : shelf === 'closed'
              ? 'Venues the partner closed, plus ones Circls rejected. Neither is on the consumer portal.'
              : 'Every venue this organisation has created.'}
        </p>
        <ShelfTabs value={shelf} onChange={setShelf} options={VENUE_SHELVES} label="Venue shelf" />
      </div>
      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-red-600">
          Failed to load venues: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">
          {shelf === 'active'
            ? 'No active venues. Closed and rejected ones are on the other tab.'
            : shelf === 'closed'
              ? 'No closed or rejected venues.'
              : 'This tenant has no venues.'}
        </p>
      ) : (
        <TableShell>
          <thead className={THEAD_CLASS}>
            <tr>
              <Th>Venue</Th>
              <Th>Location</Th>
              <Th>Timezone</Th>
              <Th>Tags</Th>
              <Th>Status</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((v) => (
              <tr key={v.id}>
                <td className="px-4 py-2.5 text-slate-800">
                  {v.name}
                  <span className="block font-mono text-[10px] text-slate-400">{v.id}</span>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-600">
                  {[v.city, v.state].filter(Boolean).join(', ') || (
                    <span className="text-slate-400">—</span>
                  )}
                  {v.lat != null && v.lng != null && (
                    <span className="block font-mono text-[10px] text-slate-400">
                      {v.lat.toFixed(4)}, {v.lng.toFixed(4)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{v.tzName}</td>
                <td className="px-4 py-2.5">
                  {v.tags.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {v.tags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {/* A partner's own suspended venue is "Closed" on their portal. */}
                  <ListingStatusPill
                    status={v.status}
                    {...(v.status === 'suspended' ? { label: 'Closed' } : {})}
                  />
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">{fmtDate(v.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </section>
  );
}

// ── Events ────────────────────────────────────────────────────────────────────

/** The partner portal's three shelves; "Active" there means not archived. */
const EVENT_SHELVES: { key: AdminTenantEventScope; label: string }[] = [
  { key: 'unarchived', label: 'Active' },
  { key: 'archived', label: 'Archived' },
  { key: 'all', label: 'All' },
];

export function EventsTab({ tenantId }: { tenantId: string }) {
  const [scope, setScope] = useState<AdminTenantEventScope>('unarchived');
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error } =
    useAdminTenantEvents(tenantId, scope);
  const rows: AdminTenantEventBillingItem[] = data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          {scope === 'unarchived'
            ? 'Everything on the partner’s working list, whatever its status. Archived events are on the other tab.'
            : scope === 'archived'
              ? 'The partner’s archive shelf.'
              : 'Every event this organisation has ever created.'}
          {' '}Times are in each event’s own timezone. Commission overrides are edited under Billing.
        </p>
        <ShelfTabs value={scope} onChange={setScope} options={EVENT_SHELVES} label="Event shelf" />
      </div>
      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-red-600">
          Failed to load events: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">
          {scope === 'archived' ? 'Nothing archived.' : 'This tenant has no events.'}
        </p>
      ) : (
        <TableShell>
          <thead className={THEAD_CLASS}>
            <tr>
              <Th>Event</Th>
              <Th>Where</Th>
              <Th>Starts</Th>
              <Th>Ends</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((ev) => (
              <tr key={ev.id}>
                <td className="px-4 py-2.5 text-slate-800">
                  {ev.name}
                  <span className="block font-mono text-[10px] text-slate-400">{ev.id}</span>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-600">
                  {ev.venueName ?? <span className="text-slate-500">Standalone</span>}
                  {ev.seriesId && (
                    <span className="ml-1">
                      <Tag>Recurring</Tag>
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {fmtEventTime(ev.startsAt, ev.tzName)}
                  {ev.tzName && (
                    <span className="block font-mono text-[10px] text-slate-400">{ev.tzName}</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {fmtEventTime(ev.endsAt, ev.tzName)}
                </td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1">
                    <ListingStatusPill status={ev.status} />
                    {/* Only All mixes shelves; on Archived every row would carry it. */}
                    {scope === 'all' && ev.archived && <Tag>Archived</Tag>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
      {hasNextPage && (
        <button
          type="button"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more events'}
        </button>
      )}
    </section>
  );
}

// ── Memberships ───────────────────────────────────────────────────────────────

const MEMBERSHIP_SHELVES: { key: AdminTenantMembershipShelf; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'inactive', label: 'Inactive & rejected' },
  { key: 'all', label: 'All' },
];

export function MembershipsTab({ tenantId }: { tenantId: string }) {
  const [shelf, setShelf] = useState<AdminTenantMembershipShelf>('active');
  const { data, isLoading, isError, error } = useAdminTenantMemberships(tenantId, shelf);
  const rows: AdminTenantMembershipItem[] = data ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">
          {shelf === 'active'
            ? 'Plans on sale and ones awaiting review.'
            : shelf === 'inactive'
              ? 'Plans the partner switched off, plus ones Circls rejected.'
              : 'Every membership plan this organisation has created.'}
        </p>
        <ShelfTabs
          value={shelf}
          onChange={setShelf}
          options={MEMBERSHIP_SHELVES}
          label="Membership shelf"
        />
      </div>
      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-red-600">
          Failed to load memberships: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">
          {shelf === 'active'
            ? 'No active plans. Inactive and rejected ones are on the other tab.'
            : shelf === 'inactive'
              ? 'No inactive or rejected plans.'
              : 'This tenant has no membership plans.'}
        </p>
      ) : (
        <TableShell>
          <thead className={THEAD_CLASS}>
            <tr>
              <Th>Plan</Th>
              <Th>Scope</Th>
              <Th>Tiers</Th>
              <Th>Status</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="px-4 py-2.5 text-slate-800">
                  {m.name}
                  {m.description && (
                    <span className="block text-xs text-slate-400">{m.description}</span>
                  )}
                  <span className="block font-mono text-[10px] text-slate-400">{m.id}</span>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-600">
                  {m.venueId ? (
                    (m.venueName ?? 'Venue')
                  ) : (
                    <span className="text-slate-500">Org-wide</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-xs text-slate-600">
                  {tiersSummary(m)}
                </td>
                <td className="px-4 py-2.5">
                  <ListingStatusPill status={m.status} />
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">{fmtDate(m.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      )}
    </section>
  );
}
