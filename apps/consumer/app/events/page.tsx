'use client';
import { Header } from '@/components/Header';
import { EventCard } from '@/components/cards/EventCard';
import { CardSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useUpcomingEvents } from '@/lib/api/consumer';
import { useLocation } from '@/lib/location/LocationProvider';
import { inCountry } from '@/lib/location/geo';
import { formatDayLabel } from '@/lib/format';
import type { PublicEventWithVenue } from '@/lib/api/types';

/** Group events (already ascending) by calendar day for date dividers. */
function groupByDay(rows: PublicEventWithVenue[]): { label: string; events: PublicEventWithVenue[] }[] {
  const groups: { label: string; events: PublicEventWithVenue[] }[] = [];
  for (const ev of rows) {
    const label = formatDayLabel(ev.startsAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.events.push(ev);
    else groups.push({ label, events: [ev] });
  }
  return groups;
}

export default function EventsPage() {
  const { country, openPicker } = useLocation();
  const events = useUpcomingEvents(100);
  const now = Date.now();
  const upcoming = (events.data ?? [])
    // Defensive guard: never show a past event even if the API regresses.
    .filter((e) => new Date(e.endsAt).getTime() >= now)
    // Events belong to one country; show only the user's (unknown-country shown).
    .filter((e) => inCountry(e.locAddressJson, country));
  const groups = groupByDay(upcoming);

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-1 font-display text-4xl font-extrabold text-ink">What&apos;s on</h1>
        <p className="mb-8 text-sm text-text-secondary">
          {country ? (
            <>
              Upcoming events in <span className="font-semibold text-ink">{country}</span>.{' '}
              <button onClick={openPicker} className="font-semibold text-ink underline hover:text-coral-deep">
                Change
              </button>
            </>
          ) : (
            'Upcoming events across every country.'
          )}
        </p>

        {events.isLoading ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : events.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {events.error instanceof Error ? events.error.message : 'Failed to load events'}
          </p>
        ) : upcoming.length === 0 ? (
          <EmptyState title="Nothing on right now" body="There are no upcoming events yet. Check back soon — new ones drop all the time." />
        ) : (
          <div className="space-y-8">
            {groups.map((g) => (
              <div key={g.events[0]!.id}>
                <h2 className="mb-3 font-display text-lg font-extrabold text-ink">{g.label}</h2>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {g.events.map((e) => <EventCard key={e.id} event={e} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
