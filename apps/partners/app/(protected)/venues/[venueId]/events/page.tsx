'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useVenueEvents, usePublishEvent } from '@/lib/api/events';
import { Badge, Button, Card } from '@/lib/ui';
import { useState } from 'react';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function fmt(iso: string) {
  return IST_FMT.format(new Date(iso));
}

function statusTone(status: string): 'success' | 'warning' | 'open' | 'neutral' {
  if (status === 'published') return 'success';
  if (status === 'cancelled') return 'warning';
  if (status === 'draft') return 'open';
  return 'neutral';
}

export default function VenueEventsPage() {
  const { venueId } = useParams<{ venueId: string }>();
  const tenantId = useSearchParams().get('tenantId') ?? '';
  const { data: events, isLoading } = useVenueEvents(venueId);
  const publish = usePublishEvent(tenantId, venueId);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handlePublish(id: string) {
    setErrorMsg(null);
    try {
      await publish.mutateAsync(id);
    } catch (e) {
      setErrorMsg((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/venues/${venueId}${tenantId ? `?tenantId=${tenantId}` : ''}`}
        className="text-sm text-slate-500 hover:text-slate-800 transition-colors"
      >
        &larr; Back to venue
      </Link>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-[#0f172a]">Events</h1>
        <Link
          href={`/venues/${venueId}/events/new${tenantId ? `?tenantId=${tenantId}` : ''}`}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          + New event
        </Link>
      </div>

      {errorMsg && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {errorMsg}
        </p>
      )}

      <Card title="All events" subtitle="Tournaments, classes, and other venue-level happenings.">
        {isLoading && <p className="py-6 text-center text-sm text-slate-400">Loading…</p>}
        {!isLoading && events?.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">
            No events yet. Click <span className="font-medium">+ New event</span> to create one.
          </p>
        )}
        {!isLoading && events && events.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e5e7eb] text-left">
                  <th className="pb-2 pr-4 font-medium text-slate-500">Name</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">When (IST)</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Price</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Capacity</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
                  <th className="pb-2 font-medium text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {events.map((ev) => (
                  <tr key={ev.id} className="align-top">
                    <td className="py-2.5 pr-4 text-slate-700 font-medium">{ev.name}</td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {fmt(ev.startsAt)} → {fmt(ev.endsAt)}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">
                      {ev.pricePaise === 0 ? (
                        <span className="text-emerald-600">Free</span>
                      ) : (
                        `₹${(ev.pricePaise / 100).toFixed(2)}`
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">
                      {ev.capacity ?? <span className="text-slate-400">∞</span>}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge tone={statusTone(ev.status)} label={ev.status} />
                    </td>
                    <td className="py-2.5">
                      {ev.status === 'draft' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={publish.isPending}
                          onClick={() => handlePublish(ev.id)}
                        >
                          Publish
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
