'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import { useTenantEvents, usePublishTenantEvent } from '@/lib/api/events';
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

function EventList({ tenantId }: { tenantId: string }) {
  const { data: events, isLoading } = useTenantEvents(tenantId);
  const publish = usePublishTenantEvent(tenantId);
  const { resolveTz } = useTimezone();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handlePublish(id: string) {
    setErrorMsg(null);
    try {
      await publish.mutateAsync(id);
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
        {events.map((ev) => (
          <li
            key={ev.id}
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
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone="neutral" label={ev.venueId ? 'Venue' : 'Standalone'} />
                <StatusPill status={ev.status} />
                {ev.status === 'draft' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={publish.isPending}
                    onClick={() => handlePublish(ev.id)}
                  >
                    Submit for review
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
