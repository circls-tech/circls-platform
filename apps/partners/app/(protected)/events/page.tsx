'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import {
  useArchiveTenantEvent,
  useCompleteTenantEvent,
  useTenantEvents,
  usePublishEventSeries,
  usePublishTenantEvent,
  type EventShelf,
} from '@/lib/api/events';
import type { VenueEventSummary } from '@/lib/api/types';
import { Badge, Button, Card, StatusPill } from '@/lib/ui';

/** Format an event start in a given zone. Each event's natural zone is its own
 *  `tzName`; the portal-wide viewing tz overrides it when set. */
function fmtEventTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

/** One list row: a one-off event, or a whole recurring series collapsed. */
interface EventRow {
  ev: VenueEventSummary;
  /** 1 for one-offs; dates in the series otherwise (row shows the soonest). */
  seriesSize: number;
  /** Any date of the series still in draft (enables submit-all). */
  seriesHasDraft: boolean;
}

/** Collapse series occurrences into one row keyed by the soonest date. */
function groupRows(events: VenueEventSummary[]): EventRow[] {
  const byKey = new Map<string, EventRow>();
  const order: string[] = [];
  for (const ev of events) {
    const key = ev.seriesId ?? ev.id;
    const row = byKey.get(key);
    if (!row) {
      byKey.set(key, { ev, seriesSize: 1, seriesHasDraft: ev.status === 'draft' });
      order.push(key);
    } else {
      row.seriesSize += 1;
      row.seriesHasDraft = row.seriesHasDraft || ev.status === 'draft';
      if (new Date(ev.startsAt) < new Date(row.ev.startsAt)) row.ev = ev;
    }
  }
  return order.map((k) => byKey.get(k)!);
}

const SHELF_TABS: { key: EventShelf; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'archived', label: 'Archived' },
  { key: 'all', label: 'All' },
];

function EventList({ tenantId }: { tenantId: string }) {
  const [shelf, setShelf] = useState<EventShelf>('active');
  const { data: events, isLoading } = useTenantEvents(tenantId, shelf);
  const publish = usePublishTenantEvent(tenantId);
  const publishSeries = usePublishEventSeries(tenantId);
  const complete = useCompleteTenantEvent(tenantId);
  const archive = useArchiveTenantEvent(tenantId);
  const { resolveTz } = useTimezone();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const rows = useMemo(() => groupRows(events ?? []), [events]);

  async function handlePublish(row: EventRow) {
    setErrorMsg(null);
    try {
      if (row.ev.seriesId) {
        await publishSeries.mutateAsync(row.ev.seriesId);
      } else {
        await publish.mutateAsync(row.ev.id);
      }
    } catch (e) {
      setErrorMsg((e as Error).message);
    }
  }

  async function run(action: () => Promise<unknown>) {
    setErrorMsg(null);
    try {
      await action();
    } catch (e) {
      setErrorMsg((e as Error).message);
    }
  }

  const tabs = (
    <div className="flex gap-1" role="tablist" aria-label="Event shelf">
      {SHELF_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={shelf === t.key}
          onClick={() => setShelf(t.key)}
          className={[
            'rounded-[var(--radius)] border-2 px-3 py-1 text-sm font-bold transition-colors',
            shelf === t.key
              ? 'border-[#17151D] bg-[#9CE0D4] text-[#17151D] shadow-[2px_2px_0_#17151D]'
              : 'border-transparent text-slate-500 hover:bg-white hover:text-[#17151D]',
          ].join(' ')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        {tabs}
        <p className="text-sm text-slate-500">Loading events…</p>
      </div>
    );
  }
  if (!events || events.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {tabs}
        <p className="text-sm text-slate-500">
          {shelf === 'archived'
            ? 'Nothing archived.'
            : 'No events yet for this organization.'}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {tabs}
      {errorMsg && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {errorMsg}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {rows.map(({ ev, seriesSize, seriesHasDraft }) => (
          <li
            key={ev.seriesId ?? ev.id}
            className="rounded-[var(--radius)] border-2 border-[#17151D] bg-white p-4 shadow-[4px_4px_0_#17151D]"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <Link
                  href={`/events/${ev.id}`}
                  className="font-[family-name:var(--font-display)] text-lg font-bold text-[#17151D] hover:underline"
                >
                  {ev.name}
                </Link>
                <p className="mt-0.5 text-xs text-slate-400">
                  {fmtEventTime(ev.startsAt, resolveTz(ev.tzName))}
                  {seriesSize > 1 && ` · first of ${seriesSize} dates`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {seriesSize > 1 && <Badge tone="neutral" label={`Recurring ×${seriesSize}`} />}
                <Badge tone="neutral" label={ev.venueId ? 'Venue' : 'Standalone'} />
                <StatusPill status={ev.status} />
                {(ev.seriesId ? seriesHasDraft : ev.status === 'draft') && (
                  <Button
                    petal="#A7E3BF"
                    size="sm"
                    loading={publish.isPending || publishSeries.isPending}
                    onClick={() => handlePublish({ ev, seriesSize, seriesHasDraft })}
                  >
                    {ev.seriesId ? 'Submit series for review' : 'Submit for review'}
                  </Button>
                )}
                {ev.status === 'pending_review' && (
                  <span className="text-xs text-slate-400">Awaiting Circls review</span>
                )}
                {/* Series are ended and archived per date, from the date's own
                    page — one row stands for many, so a bulk action here would
                    be ambiguous. */}
                {!ev.seriesId && ev.status === 'published' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={complete.isPending}
                    onClick={() => void run(() => complete.mutateAsync(ev.id))}
                  >
                    End
                  </Button>
                )}
                {!ev.seriesId &&
                  (ev.archivedAt ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={archive.isPending}
                      onClick={() =>
                        void run(() => archive.mutateAsync({ eventId: ev.id, archived: false }))
                      }
                    >
                      Restore
                    </Button>
                  ) : (
                    ev.status !== 'published' &&
                    ev.status !== 'pending_review' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={archive.isPending}
                        onClick={() =>
                          void run(() => archive.mutateAsync({ eventId: ev.id, archived: true }))
                        }
                      >
                        Archive
                      </Button>
                    )
                  ))}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function EventsPage() {
  const router = useRouter();
  const { activeTenantId, tenants } = useOrg();
  const activeTenant = tenants.find((t) => t.id === activeTenantId);

  if (!activeTenantId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">Events</h1>
        <Card subtitle="Select or create an organization first to view its events.">
          <p className="text-sm text-slate-500">
            No active organization. Use the switcher in the top bar to pick one.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">Events</h1>
          {activeTenant && <p className="mt-0.5 text-sm font-semibold text-[#EE5C2B]">{activeTenant.name}</p>}
        </div>
        <Button size="sm" petal="#9CE0D4" onClick={() => router.push('/events/new')}>
          Create event
        </Button>
      </div>
      <EventList tenantId={activeTenantId} />
    </div>
  );
}
