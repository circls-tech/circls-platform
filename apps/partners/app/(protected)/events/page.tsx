'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import {
  useTenantEvents,
  usePublishEventSeries,
  usePublishTenantEvent,
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

function EventList({ tenantId }: { tenantId: string }) {
  const { data: events, isLoading } = useTenantEvents(tenantId);
  const publish = usePublishTenantEvent(tenantId);
  const publishSeries = usePublishEventSeries(tenantId);
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

  if (isLoading) return <p className="text-sm text-slate-500">Loading events…</p>;
  if (!events || events.length === 0) {
    return <p className="text-sm text-slate-500">No events yet for this organization.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {errorMsg && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {errorMsg}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {rows.map(({ ev, seriesSize, seriesHasDraft }) => (
          <li
            key={ev.seriesId ?? ev.id}
            className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white p-4 shadow-sm"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <Link
                  href={`/events/${ev.id}`}
                  className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
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
                    variant="secondary"
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
        <h1 className="text-xl font-semibold text-[#0f172a]">Events</h1>
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
          <h1 className="text-xl font-semibold text-[#0f172a]">Events</h1>
          {activeTenant && <p className="mt-0.5 text-sm text-slate-500">{activeTenant.name}</p>}
        </div>
        <Button onClick={() => router.push('/events/new')}>Create event</Button>
      </div>
      <EventList tenantId={activeTenantId} />
    </div>
  );
}
