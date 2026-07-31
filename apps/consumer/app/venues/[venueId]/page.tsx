'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { BackBar } from '@/components/BackBar';
import { ImageCarousel } from '@/components/ImageCarousel';
import { AddressLink } from '@/components/AddressLink';
import { SportImage } from '@/components/SportImage';
import { OrgBrandBlock } from '@/components/OrgBrandBlock';
import { QuestionsSection } from '@/components/questions/QuestionsSection';
import { SlideOver } from '@/components/questions/SlideOver';
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
import { formatAddress, formatOpeningHours } from '@/lib/trust';
import {
  type CurrencyCode,
  currencyForCountry,
  formatDateTime,
  formatDayMonth,
  formatPaise,
  formatSlotRange,
} from '@/lib/format';
import { useCheckoutModal } from '@/lib/checkout/CheckoutProvider';
import { Badge, Button, Card } from '@/lib/ui';

/** A slot held in the cart, with the display info the cart summary needs. */
export interface CartSlot {
  id: string;
  arenaId: string;
  arenaName: string;
  startAt: string;
  endAt: string;
  pricePaise: number;
}

export default function VenuePage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = use(params);
  const venueQ = useVenue(venueId);
  const eventsQ = useVenueEvents(venueId);
  const membershipsQ = useVenueMemberships(venueId);
  // Owning-org profile, enriches the "Hosted by" byline. Degrades to the
  // compact brand summary when still loading or the org is unavailable.
  const orgQ = usePublicOrg(venueQ.data?.venue.brand?.slug ?? '');
  // Cart of slots across the courts of THIS venue. Keyed by slot id; the booking
  // endpoint takes the combined slotIds and books them as one multi-arena
  // booking with a single payment.
  const [cart, setCart] = useState<Map<string, CartSlot>>(new Map());
  // Prices at this venue are denominated by the venue's country.
  const currency = currencyForCountry(venueQ.data?.venue.address.country);

  function toggleCartSlot(slot: CartSlot) {
    setCart((prev) => {
      const next = new Map(prev);
      if (next.has(slot.id)) next.delete(slot.id);
      else next.set(slot.id, slot);
      return next;
    });
  }
  function removeFromCart(id: string) {
    setCart((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }
  function clearCart() {
    setCart(new Map());
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className={`mx-auto max-w-5xl px-4 pt-8${cart.size > 0 ? ' pb-32' : ' pb-8'}`}>
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
            <div className="mb-6 overflow-hidden rounded-card border-[2px] border-ink shadow-offset">
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
                <AddressLink
                  addressJson={venueQ.data.venue.addressJson}
                  lat={venueQ.data.venue.lat}
                  lng={venueQ.data.venue.lng}
                />
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
                      currency={currency}
                      cart={cart}
                      onToggleSlot={toggleCartSlot}
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
                    <EventCard key={ev.id} event={ev} currency={currency} />
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

            {cart.size > 0 && (
              <CartBar
                cart={cart}
                venueName={venueQ.data.venue.name}
                currency={currency}
                onRemove={removeFromCart}
                onClear={clearCart}
              />
            )}
          </>
        )}
      </main>

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
  currency,
  cart,
  onToggleSlot,
}: {
  arena: PublicArena;
  currency: CurrencyCode;
  cart: Map<string, CartSlot>;
  onToggleSlot: (slot: CartSlot) => void;
}) {
  const [date, setDate] = useState(todayLocal());
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const { from, to } = dayBounds(date);
  const slotsQ = useArenaSlots(arena.id, from, to);
  const slots = slotsQ.data ?? [];

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-extrabold text-ink">{arena.name}</h3>
          <p className="mt-0.5 text-sm text-text-secondary">
            {arena.sport ?? 'General'}
            {arena.capacity != null ? ` · up to ${arena.capacity}` : ''}
            {' · '}
            {/* Q&A on this court (#106); threads load lazily when the panel opens. */}
            <button
              type="button"
              onClick={() => setQuestionsOpen(true)}
              className="font-semibold text-coral-deep underline"
            >
              Questions
            </button>
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          Date
          <input
            type="date"
            value={date}
            min={todayLocal()}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-[var(--radius)] border-[2px] border-ink px-2 py-1 text-sm text-ink"
          />
        </label>
      </div>

      <SlideOver
        open={questionsOpen}
        onClose={() => setQuestionsOpen(false)}
        ariaLabel={`Questions about ${arena.name}`}
        title={
          <h3 className="truncate font-display text-lg font-extrabold text-ink">
            Questions · {arena.name}
          </h3>
        }
      >
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <QuestionsSection
            subjectType="arena"
            subjectId={arena.id}
            subjectName={arena.name}
            showHeading={false}
          />
        </div>
      </SlideOver>

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
            <p className="mb-2 text-xs text-text-secondary">Tap to add slots to your cart — mix courts and book them together.</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {slots.map((slot) => {
                const slotLabel = formatSlotRange(slot.startAt, slot.endAt);
                const inCart = cart.has(slot.id);
                return (
                  <button
                    key={slot.id}
                    type="button"
                    onClick={() =>
                      onToggleSlot({
                        id: slot.id,
                        arenaId: arena.id,
                        arenaName: arena.name,
                        startAt: slot.startAt,
                        endAt: slot.endAt,
                        pricePaise: slot.pricePaise,
                      })
                    }
                    aria-pressed={inCart}
                    className={[
                      'flex min-h-[3rem] flex-col items-start justify-center rounded-[var(--radius)] border-[2px] px-3 py-2 text-left transition-colors',
                      inCart
                        ? 'border-ink bg-coral text-ink shadow-offset-sm'
                        : 'border-ink bg-white hover:bg-coral-soft',
                    ].join(' ')}
                  >
                    <span className="text-xs font-medium leading-tight tabular-nums text-ink sm:text-sm">{slotLabel}</span>
                    <span className="text-xs text-text-secondary">{formatPaise(slot.pricePaise, currency)}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * Floating cart bar (venue-scoped). Collects slots across courts; expands to a
 * removable line-item list and checks out the whole cart as one booking + one
 * payment. Fixed to the viewport bottom so it's reachable without scrolling —
 * most useful on mobile, where the slot grids are tall.
 */
function CartBar({
  cart,
  venueName,
  currency,
  onRemove,
  onClear,
}: {
  cart: Map<string, CartSlot>;
  venueName: string;
  currency: CurrencyCode;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const { openCheckout } = useCheckoutModal();
  const [expanded, setExpanded] = useState(false);

  // Stable order: by court name, then start time.
  const items = [...cart.values()].sort(
    (a, b) => a.arenaName.localeCompare(b.arenaName) || a.startAt.localeCompare(b.startAt),
  );
  const total = items.reduce((sum, i) => sum + i.pricePaise, 0);
  const courts = new Set(items.map((i) => i.arenaId)).size;
  const n = items.length;

  function book() {
    openCheckout(
      {
        kind: 'slot',
        slotIds: items.map((i) => i.id),
        title: `${venueName} · ${n} slot${n > 1 ? 's' : ''}${courts > 1 ? ` · ${courts} courts` : ''}`,
        currency,
      },
      {},
      { onSuccess: onClear },
    );
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t-[2px] border-ink bg-white shadow-offset-sm [padding-bottom:env(safe-area-inset-bottom)]">
      <div className="mx-auto max-w-5xl px-4">
        {expanded && (
          <div className="max-h-64 overflow-y-auto border-b-[1.5px] border-dashed border-ink/20 py-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-display text-sm font-extrabold text-ink">Your cart</span>
              <button type="button" onClick={onClear} className="text-xs font-medium text-text-secondary underline">
                Clear all
              </button>
            </div>
            <ul className="flex flex-col gap-1.5">
              {items.map((i) => {
                const { day, month } = formatDayMonth(i.startAt);
                return (
                  <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate text-ink">
                      <span className="font-medium">{i.arenaName}</span>
                      <span className="text-text-secondary"> · {day} {month} · {formatSlotRange(i.startAt, i.endAt)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="tabular-nums text-text-secondary">{formatPaise(i.pricePaise, currency)}</span>
                      <button
                        type="button"
                        onClick={() => onRemove(i.id)}
                        aria-label={`Remove ${i.arenaName} slot`}
                        className="rounded px-1.5 text-lg leading-none text-text-secondary hover:text-petal-red"
                      >
                        ×
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 py-3">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex min-w-0 flex-col items-start text-left"
            aria-expanded={expanded}
          >
            <span className="font-display text-sm font-extrabold text-ink">
              {n} slot{n > 1 ? 's' : ''} · {courts} court{courts > 1 ? 's' : ''} · {formatPaise(total, currency)}
            </span>
            <span className="text-xs text-text-secondary underline">{expanded ? 'Hide cart' : 'View cart'}</span>
          </button>
          <Button onClick={book}>Book {n} slot{n > 1 ? 's' : ''}</Button>
        </div>
      </div>
    </div>
  );
}

function EventCard({ event, currency }: { event: PublicEvent; currency: CurrencyCode }) {
  const isFree = event.pricePaise === 0;
  return (
    <Card className="flex h-full flex-col">
      <h3 className="font-display text-lg font-extrabold text-ink">{event.name}</h3>
      <p className="mt-0.5 text-sm text-text-secondary">
        {formatDateTime(event.startsAt)}
        {(event.seriesCount ?? 1) > 1 && (
          <span className="font-medium text-ink"> · {event.seriesCount} dates</span>
        )}
      </p>
      {event.description && (
        <p className="mt-2 text-sm text-text-secondary line-clamp-3">{event.description}</p>
      )}
      <div className="mt-3 flex items-center gap-2 text-sm text-text-secondary">
        <span className="font-medium text-ink">{formatPaise(event.pricePaise, currency)}</span>
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
