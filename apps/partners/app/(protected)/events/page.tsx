'use client';
import { useRouter } from 'next/navigation';
import { useOrg } from '@/lib/org_context';
import { useTenantEvents } from '@/lib/api/events';
import { Badge, Button, Card, StatusPill } from '@/lib/ui';

const IST = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  dateStyle: 'medium',
  timeStyle: 'short',
});

function EventList({ tenantId }: { tenantId: string }) {
  const { data: events, isLoading } = useTenantEvents(tenantId);
  if (isLoading) return <p className="text-sm text-slate-500">Loading events…</p>;
  if (!events || events.length === 0) {
    return <p className="text-sm text-slate-500">No events yet for this organization.</p>;
  }
  return (
    <ul className="flex flex-col gap-3">
      {events.map((ev) => (
        <li
          key={ev.id}
          className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white p-4 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-[#0f172a]">{ev.name}</p>
              <p className="mt-0.5 text-xs text-slate-400">{IST.format(new Date(ev.startsAt))}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone="neutral" label={ev.venueId ? 'Venue' : 'Standalone'} />
              <StatusPill status={ev.status} />
            </div>
          </div>
        </li>
      ))}
    </ul>
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
