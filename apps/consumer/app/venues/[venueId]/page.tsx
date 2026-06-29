'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { BackBar } from '@/components/BackBar';
import { StickyActionBar } from '@/components/StickyActionBar';
import { ImageCarousel } from '@/components/ImageCarousel';
import { SportImage } from '@/components/SportImage';
import { OrgBrandBlock } from '@/components/OrgBrandBlock';
import { matchSport } from '@/lib/sportImages';
import { MembershipCard } from '@/components/cards/MembershipCard';
import {
  useArenaSlots,
  usePublicOrg,
  useVenue,
  useVenueEvents,
  useVenueMemberships,
} from '@/lib/api/consumer';
import type { PublicArena, PublicEvent, PublicVenue } from '@/lib/api/types';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatAddress, formatOpeningHours } from '@/lib/trust';
import { formatDateTime, formatPaise, formatTime } from '@/lib/format';
import { useCheckoutModal } from '@/lib/checkout/CheckoutProvider';
import { Badge, Button, Card } from '@/lib/ui';

/** The arena currently driving the page-level sticky Book bar. Booking is
 *  per-arena, so only one arena's selection is "active" at a time. */
type ActiveSelection = {
  arenaId: string;
  arenaName: string;
  slotIds: string[];
  totalPaise: number;
};

export default function VenuePage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = use(params);
  const venueQ = useVenue(venueId);
  const eventsQ = useVenueEvents(venueId);
  const membershipsQ = useVenueMemberships(venueId);
  const { openCheckout } = useCheckoutModal();
  // Whichever arena the user is currently picking slots in. Selecting in a
  // different arena replaces this (the other arena clears its highlight).
  const [active, setActive] = useState<ActiveSelection | null>(null);
  // Owning-org profile, enriches the "Hosted by" byline. Degrades to the
  // compact brand summary when still loading or the org is unavailable.
  const orgQ = usePublicOrg(venueQ.data?.venue.brand?.slug ?? '');

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-5xl px-4 pt-8 pb-28">
        <BackBar />
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
                {venueQ.data.venue.brand && (
                  <div className="mt-4 border-t-[1.5px] border-dashed border-ink/15 pt-4">
                    <OrgBrandBlock brand={venueQ.data.venue.brand} org={orgQ.data} label="Hosted by" />
                  </div>
                )}
              </div>
            </div>

            {/* About the venue */}
            <AboutVenue venue={venueQ.data.venue} />

            {/* Arenas */}
            <section className="mb-8">
              <h2 className="mb-3 font-display text-xl font-extrabold text-ink">Courts &amp; turfs</h2>
              {venueQ.data.arenas.length === 0 ? (
                <Card><p className="text-sm text-text-secondary">No bookable arenas yet.</p></Card>
              ) : (
                <div className="flex flex-col gap-4">
                  {venueQ.data.arenas.map((arena) => (
                    <ArenaCard
                      key={arena.id}
                      arena={arena}
                      isActive={active?.arenaId === arena.id}
                      onSelectionChange={setActive}
                    />
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

      {active && (
        <StickyActionBar
          summary={
            <>
              <span className="font-display font-extrabold text-ink">{active.arenaName}</span>
              <span className="text-text-secondary">
                {' · '}
                {active.slotIds.length} slot{active.slotIds.length > 1 ? 's' : ''} · {formatPaise(active.totalPaise)}
              </span>
            </>
          }
          action={
            <Button
              onClick={() =>
                openCheckout({
                  kind: 'slot',
                  slotIds: active.slotIds,
                  title: `${active.arenaName} · ${active.slotIds.length} slot${active.slotIds.length > 1 ? 's' : ''}`,
                })
              }
            >
              Book {active.slotIds.length} slot{active.slotIds.length > 1 ? 's' : ''}
            </Button>
          }
        />
      )}
    </div>
  );
}

/** "About the venue" — the trust metadata (PR #109). Renders only the sections
 *  that have data, and nothing at all when the venue carries no metadata. */
function AboutVenue({ venue }: { venue: PublicVenue }) {
  const address = formatAddress(venue.address);
  const hours = formatOpeningHours(venue.openingHours);
  const hasContact = Boolean(venue.contactPhone || venue.contactEmail);
  const hasContent =
    Boolean(venue.description) ||
    venue.amenities.length > 0 ||
    Boolean(hours) ||
    hasContact ||
    Boolean(address);
  if (!hasContent) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 font-display text-xl font-extrabold text-ink">About the venue</h2>
      <Card className="flex flex-col gap-4">
        {venue.description && (
          <p className="whitespace-pre-line text-sm text-text-secondary">{venue.description}</p>
        )}

        {venue.amenities.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-ink">Amenities</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {venue.amenities.map((a) => (
                <Badge key={a} tone="neutral" label={a} />
              ))}
            </div>
          </div>
        )}

        {hours && (
          <div>
            <h3 className="text-sm font-semibold text-ink">Opening hours</h3>
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {hours.map((row) => (
                <div key={row.day} className="flex justify-between gap-3">
                  <dt className="text-ink-soft">{row.day}</dt>
                  <dd className={row.closed ? 'text-text-secondary' : 'text-ink'}>{row.label}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {(hasContact || address) && (
          <div>
            <h3 className="text-sm font-semibold text-ink">Contact</h3>
            <ul className="mt-2 space-y-1 text-sm">
              {address && <li className="text-text-secondary">{address}</li>}
              {venue.contactPhone && (
                <li>
                  <a href={`tel:${venue.contactPhone}`} className="text-coral-deep underline">{venue.contactPhone}</a>
                </li>
              )}
              {venue.contactEmail && (
                <li>
                  <a href={`mailto:${venue.contactEmail}`} className="text-coral-deep underline">{venue.contactEmail}</a>
                </li>
              )}
            </ul>
          </div>
        )}
      </Card>
    </section>
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

function ArenaCard({
  arena,
  isActive,
  onSelectionChange,
}: {
  arena: PublicArena;
  /** True when THIS arena owns the page-level sticky Book bar. */
  isActive: boolean;
  /** Report this arena's current selection (or null when it clears). */
  onSelectionChange: (sel: ActiveSelection | null) => void;
}) {
  const [date, setDate] = useState(todayLocal());
  const { from, to } = dayBounds(date);
  const slotsQ = useArenaSlots(arena.id, from, to);
  // Selected slot ids for THIS arena+date. Backend books multiple slots in one
  // arena atomically (POST /v1/consumer/bookings takes slotIds[]), so we let the
  // user pick several and check out together. The booking CTA lives in a single
  // page-level sticky bar, so we lift the active selection up via onSelectionChange.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const slots = slotsQ.data ?? [];
  const selectedSlots = slots.filter((s) => selected.has(s.id));
  const selectedTotal = selectedSlots.reduce((sum, s) => sum + s.pricePaise, 0);

  // When another arena takes over the active selection, drop our highlight.
  useEffect(() => {
    if (!isActive) setSelected((prev) => (prev.size ? new Set() : prev));
  }, [isActive]);

  /** Push the given selection up to the page so it can render the sticky bar. */
  function report(next: Set<string>) {
    const sel = slots.filter((s) => next.has(s.id));
    if (sel.length === 0) {
      if (isActive) onSelectionChange(null);
      return;
    }
    onSelectionChange({
      arenaId: arena.id,
      arenaName: arena.name,
      slotIds: sel.map((s) => s.id),
      totalPaise: sel.reduce((sum, s) => sum + s.pricePaise, 0),
    });
  }

  function changeDate(d: string) {
    setDate(d);
    setSelected(new Set()); // selection is per-day; slots differ across dates
    if (isActive) onSelectionChange(null);
  }
  function toggle(slotId: string) {
    const next = new Set(selected);
    if (next.has(slotId)) next.delete(slotId);
    else next.add(slotId);
    setSelected(next);
    report(next);
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-extrabold text-ink">{arena.name}</h3>
          <p className="mt-0.5 text-sm text-text-secondary">
            {arena.sport ?? 'General'}
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
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
              <p className="mt-3 text-sm text-text-secondary">
                {selectedSlots.length} slot{selectedSlots.length > 1 ? 's' : ''} selected · {formatPaise(selectedTotal)}
              </p>
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
