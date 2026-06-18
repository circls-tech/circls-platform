'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { ImageCarousel } from '@/components/ImageCarousel';
import { SportImage } from '@/components/SportImage';
import { matchSport } from '@/lib/sportImages';
import { MembershipCard } from '@/components/cards/MembershipCard';
import {
  useArenaSlots,
  useVenue,
  useVenueEvents,
  useVenueMemberships,
} from '@/lib/api/consumer';
import type { PublicArena, PublicEvent } from '@/lib/api/types';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatDateTime, formatPaise, formatTime } from '@/lib/format';
import { useCheckoutModal } from '@/lib/checkout/CheckoutProvider';
import { Badge, Button, Card } from '@/lib/ui';

export default function VenuePage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = use(params);
  const venueQ = useVenue(venueId);
  const eventsQ = useVenueEvents(venueId);
  const membershipsQ = useVenueMemberships(venueId);

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-8">
        {venueQ.isLoading ? (
          <p className="text-sm text-text-secondary">Loading venue…</p>
        ) : venueQ.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {venueQ.error instanceof Error ? venueQ.error.message : 'Failed to load venue'}
          </p>
        ) : !venueQ.data ? (
          <p className="text-sm text-text-secondary">Venue not found.</p>
        ) : (
          <>
            <div className="mb-6 overflow-hidden rounded-card border-[2.5px] border-ink shadow-offset">
              <ImageCarousel
                images={venueQ.data.venue.images}
                alt={venueQ.data.venue.name}
                label={matchSport(venueQ.data.venue.tags) ?? undefined}
                className="h-44 sm:h-56"
                fallback={
                  <SportImage
                    input={{ tags: venueQ.data.venue.tags }}
                    alt={venueQ.data.venue.name}
                    label={matchSport(venueQ.data.venue.tags) ?? undefined}
                    className="h-44 sm:h-56"
                  />
                }
              />
              <div className="bg-white p-5">
                <h1 className="font-display text-4xl font-extrabold text-ink">{venueQ.data.venue.name}</h1>
                {venueQ.data.venue.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {venueQ.data.venue.tags.map((tag) => (
                      <Badge key={tag} tone="sport" label={tag} />
                    ))}
                  </div>
                )}
                <AddressLine addressJson={venueQ.data.venue.addressJson} />
              </div>
            </div>

            {/* Arenas */}
            <section className="mb-8">
              <h2 className="mb-3 font-display text-xl font-extrabold text-ink">Courts &amp; turfs</h2>
              {venueQ.data.arenas.length === 0 ? (
                <Card><p className="text-sm text-text-secondary">No bookable arenas yet.</p></Card>
              ) : (
                <div className="flex flex-col gap-4">
                  {venueQ.data.arenas.map((arena) => (
                    <ArenaCard key={arena.id} arena={arena} />
                  ))}
                </div>
              )}
            </section>

            {/* Events */}
            <section className="mb-8">
              <h2 className="mb-3 font-display text-xl font-extrabold text-ink">Events</h2>
              {eventsQ.isLoading ? (
                <p className="text-sm text-text-secondary">Loading events…</p>
              ) : !eventsQ.data || eventsQ.data.length === 0 ? (
                <Card><p className="text-sm text-text-secondary">No upcoming events.</p></Card>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {eventsQ.data.map((ev) => (
                    <EventCard key={ev.id} event={ev} />
                  ))}
                </div>
              )}
            </section>

            {/* Memberships */}
            <section>
              <h2 className="mb-3 font-display text-xl font-extrabold text-ink">Memberships</h2>
              {membershipsQ.isLoading ? (
                <p className="text-sm text-text-secondary">Loading memberships…</p>
              ) : !membershipsQ.data || membershipsQ.data.length === 0 ? (
                <Card><p className="text-sm text-text-secondary">No memberships available.</p></Card>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {membershipsQ.data.map((m) => (
                    <MembershipCard key={m.id} membership={m} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function AddressLine({ addressJson }: { addressJson: Record<string, unknown> | null }) {
  if (!addressJson) return null;
  const parts = ['line1', 'line2', 'city', 'state', 'pincode']
    .map((k) => addressJson[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (parts.length === 0) return null;
  return <p className="mt-2 text-sm text-text-secondary">{parts.join(', ')}</p>;
}

/** Today's local date as YYYY-MM-DD for the date input default. */
function todayLocal(): string {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}

/** Local-day [start, end) ISO bounds for a YYYY-MM-DD date. */
function dayBounds(date: string): { from: string; to: string } {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { from: start.toISOString(), to: end.toISOString() };
}

function ArenaCard({ arena }: { arena: PublicArena }) {
  const { openCheckout } = useCheckoutModal();
  const [date, setDate] = useState(todayLocal());
  const { from, to } = dayBounds(date);
  const slotsQ = useArenaSlots(arena.id, from, to);
  // Selected slot ids for THIS arena+date. Backend books multiple slots in one
  // arena atomically (POST /v1/consumer/bookings takes slotIds[]), so we let the
  // user pick several and check out together.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function changeDate(d: string) {
    setDate(d);
    setSelected(new Set()); // selection is per-day; slots differ across dates
  }
  function toggle(slotId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slotId)) next.delete(slotId);
      else next.add(slotId);
      return next;
    });
  }

  const slots = slotsQ.data ?? [];
  const selectedSlots = slots.filter((s) => selected.has(s.id));
  const selectedTotal = selectedSlots.reduce((sum, s) => sum + s.pricePaise, 0);

  function book() {
    if (selectedSlots.length === 0) return;
    const n = selectedSlots.length;
    openCheckout({
      kind: 'slot',
      slotIds: selectedSlots.map((s) => s.id),
      title: `${arena.name} · ${n} slot${n > 1 ? 's' : ''}`,
    });
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-extrabold text-ink">{arena.name}</h3>
          <p className="mt-0.5 text-sm text-text-secondary">
            {arena.sport ?? 'General'} · {arena.slotDurationMin} min slots
            {arena.capacity != null ? ` · up to ${arena.capacity}` : ''}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          Date
          <input
            type="date"
            value={date}
            min={todayLocal()}
            onChange={(e) => changeDate(e.target.value)}
            className="rounded-[var(--radius)] border-[2px] border-ink px-2 py-1 text-sm text-ink"
          />
        </label>
      </div>

      <div className="mt-4">
        {slotsQ.isLoading ? (
          <p className="text-sm text-text-secondary">Loading slots…</p>
        ) : slotsQ.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {slotsQ.error instanceof Error ? slotsQ.error.message : 'Failed to load slots'}
          </p>
        ) : slots.length === 0 ? (
          <p className="text-sm text-text-secondary">No open slots for this day.</p>
        ) : (
          <>
            <p className="mb-2 text-xs text-text-secondary">Tap to select one or more slots, then book them together.</p>
            <div className="flex flex-wrap gap-2">
              {slots.map((slot) => {
                const slotLabel = `${formatTime(slot.startAt)} – ${formatTime(slot.endAt)}`;
                const isSelected = selected.has(slot.id);
                return (
                  <button
                    key={slot.id}
                    type="button"
                    onClick={() => toggle(slot.id)}
                    aria-pressed={isSelected}
                    className={[
                      'flex flex-col items-start rounded-[var(--radius)] border-[2px] px-3 py-2 text-left transition-colors',
                      isSelected
                        ? 'border-ink bg-coral text-ink shadow-offset-sm'
                        : 'border-ink bg-white hover:bg-coral-soft',
                    ].join(' ')}
                  >
                    <span className="text-sm font-medium text-ink">{slotLabel}</span>
                    <span className="text-xs text-text-secondary">{formatPaise(slot.pricePaise)}</span>
                  </button>
                );
              })}
            </div>
            {selectedSlots.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm text-text-secondary">
                  {selectedSlots.length} slot{selectedSlots.length > 1 ? 's' : ''} · {formatPaise(selectedTotal)}
                </span>
                <Button onClick={book}>
                  Book {selectedSlots.length} slot{selectedSlots.length > 1 ? 's' : ''}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

function EventCard({ event }: { event: PublicEvent }) {
  const isFree = event.pricePaise === 0;
  return (
    <Card className="flex h-full flex-col">
      <h3 className="font-display text-lg font-extrabold text-ink">{event.name}</h3>
      <p className="mt-0.5 text-sm text-text-secondary">{formatDateTime(event.startsAt)}</p>
      {event.description && (
        <p className="mt-2 text-sm text-text-secondary line-clamp-3">{event.description}</p>
      )}
      <div className="mt-3 flex items-center gap-2 text-sm text-text-secondary">
        <span className="font-medium text-ink">{formatPaise(event.pricePaise)}</span>
        {event.capacity != null && <span>· {event.capacity} seats</span>}
      </div>
      <div className="mt-auto pt-4">
        {/* Tickets are tier-based; pick quantities on the event detail page. */}
        <Link href={`/events/${event.id}`}>
          <Button size="sm">{isFree ? 'View & register' : 'View tickets'}</Button>
        </Link>
      </div>
    </Card>
  );
}
