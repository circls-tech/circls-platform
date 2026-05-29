'use client';
import { use, useState } from 'react';
import { Header } from '@/components/Header';
import {
  useArenaSlots,
  useVenue,
  useVenueEvents,
  useVenueMemberships,
} from '@/lib/api/consumer';
import type { PublicArena, PublicEvent, PublicMembership } from '@/lib/api/types';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatDateTime, formatPaise, formatTime } from '@/lib/format';
import { useCheckout, type CheckoutState } from '@/lib/useCheckout';
import { Badge, Button, Card } from '@/lib/ui';

export default function VenuePage({ params }: { params: Promise<{ venueId: string }> }) {
  const { venueId } = use(params);
  const venueQ = useVenue(venueId);
  const eventsQ = useVenueEvents(venueId);
  const membershipsQ = useVenueMemberships(venueId);
  const checkout = useCheckout();

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-4xl px-4 py-8">
        {venueQ.isLoading ? (
          <p className="text-sm text-[#475569]">Loading venue…</p>
        ) : venueQ.isError ? (
          <p className="text-sm text-red-600">
            {venueQ.error instanceof Error ? venueQ.error.message : 'Failed to load venue'}
          </p>
        ) : !venueQ.data ? (
          <p className="text-sm text-[#475569]">Venue not found.</p>
        ) : (
          <>
            <div className="mb-6">
              <h1 className="text-2xl font-semibold text-[#0f172a]">{venueQ.data.venue.name}</h1>
              {venueQ.data.venue.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {venueQ.data.venue.tags.map((tag) => (
                    <Badge key={tag} tone="neutral" label={tag} />
                  ))}
                </div>
              )}
              <AddressLine addressJson={venueQ.data.venue.addressJson} />
            </div>

            <CheckoutBanner state={checkout.state} onDismiss={checkout.reset} />

            {/* Arenas */}
            <section className="mb-8">
              <h2 className="mb-3 text-lg font-semibold text-[#0f172a]">Courts &amp; turfs</h2>
              {venueQ.data.arenas.length === 0 ? (
                <Card><p className="text-sm text-[#475569]">No bookable arenas yet.</p></Card>
              ) : (
                <div className="flex flex-col gap-4">
                  {venueQ.data.arenas.map((arena) => (
                    <ArenaCard key={arena.id} arena={arena} checkout={checkout} />
                  ))}
                </div>
              )}
            </section>

            {/* Events */}
            <section className="mb-8">
              <h2 className="mb-3 text-lg font-semibold text-[#0f172a]">Events</h2>
              {eventsQ.isLoading ? (
                <p className="text-sm text-[#475569]">Loading events…</p>
              ) : !eventsQ.data || eventsQ.data.length === 0 ? (
                <Card><p className="text-sm text-[#475569]">No upcoming events.</p></Card>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {eventsQ.data.map((ev) => (
                    <EventCard key={ev.id} event={ev} checkout={checkout} />
                  ))}
                </div>
              )}
            </section>

            {/* Memberships */}
            <section>
              <h2 className="mb-3 text-lg font-semibold text-[#0f172a]">Memberships</h2>
              {membershipsQ.isLoading ? (
                <p className="text-sm text-[#475569]">Loading memberships…</p>
              ) : !membershipsQ.data || membershipsQ.data.length === 0 ? (
                <Card><p className="text-sm text-[#475569]">No memberships available.</p></Card>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {membershipsQ.data.map((m) => (
                    <MembershipCard key={m.id} membership={m} checkout={checkout} />
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

type Checkout = ReturnType<typeof useCheckout>;

function AddressLine({ addressJson }: { addressJson: Record<string, unknown> | null }) {
  if (!addressJson) return null;
  const parts = ['line1', 'line2', 'city', 'state', 'pincode']
    .map((k) => addressJson[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (parts.length === 0) return null;
  return <p className="mt-2 text-sm text-[#475569]">{parts.join(', ')}</p>;
}

function CheckoutBanner({ state, onDismiss }: { state: CheckoutState; onDismiss: () => void }) {
  if (state.kind === 'idle') return null;
  const tone =
    state.kind === 'success'
      ? 'bg-green-50 text-green-800 border-green-200'
      : state.kind === 'reserved'
        ? 'bg-amber-50 text-amber-800 border-amber-200'
        : 'bg-red-50 text-red-700 border-red-200';
  return (
    <div className={`mb-6 flex items-start justify-between gap-4 rounded-[var(--radius)] border px-4 py-3 text-sm ${tone}`}>
      <span>{state.message}</span>
      <button type="button" onClick={onDismiss} className="font-medium underline">
        Dismiss
      </button>
    </div>
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

function ArenaCard({ arena, checkout }: { arena: PublicArena; checkout: Checkout }) {
  const { user } = useAuth();
  const [date, setDate] = useState(todayLocal());
  const { from, to } = dayBounds(date);
  const slotsQ = useArenaSlots(arena.id, from, to);

  function handleBook(slotId: string) {
    // Prefill name/contact from the signed-in user where possible.
    const customerName = user?.displayName ?? 'Guest';
    const customerContact = user?.phoneNumber ?? user?.email ?? '';
    void checkout.bookSlotsNow({ slotIds: [slotId], customerName, customerContact });
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[#0f172a]">{arena.name}</h3>
          <p className="mt-0.5 text-sm text-[#475569]">
            {arena.sport ?? 'General'} · {arena.slotDurationMin} min slots
            {arena.capacity != null ? ` · up to ${arena.capacity}` : ''}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-[#475569]">
          Date
          <input
            type="date"
            value={date}
            min={todayLocal()}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-[var(--radius)] border border-[#e5e7eb] px-2 py-1 text-sm text-[#0f172a]"
          />
        </label>
      </div>

      <div className="mt-4">
        {slotsQ.isLoading ? (
          <p className="text-sm text-[#475569]">Loading slots…</p>
        ) : slotsQ.isError ? (
          <p className="text-sm text-red-600">
            {slotsQ.error instanceof Error ? slotsQ.error.message : 'Failed to load slots'}
          </p>
        ) : !slotsQ.data || slotsQ.data.length === 0 ? (
          <p className="text-sm text-[#475569]">No open slots for this day.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {slotsQ.data.map((slot) => (
              <button
                key={slot.id}
                type="button"
                disabled={checkout.busy}
                onClick={() => handleBook(slot.id)}
                className="flex flex-col items-start rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-left transition-colors hover:border-brand-400 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="text-sm font-medium text-[#0f172a]">
                  {formatTime(slot.startAt)} – {formatTime(slot.endAt)}
                </span>
                <span className="text-xs text-[#475569]">{formatPaise(slot.pricePaise)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function EventCard({ event, checkout }: { event: PublicEvent; checkout: Checkout }) {
  const { user } = useAuth();
  const isFree = event.pricePaise === 0;
  return (
    <Card className="flex h-full flex-col">
      <h3 className="text-base font-semibold text-[#0f172a]">{event.name}</h3>
      <p className="mt-0.5 text-sm text-[#475569]">{formatDateTime(event.startsAt)}</p>
      {event.description && (
        <p className="mt-2 text-sm text-[#475569] line-clamp-3">{event.description}</p>
      )}
      <div className="mt-3 flex items-center gap-2 text-sm text-[#475569]">
        <span className="font-medium text-[#0f172a]">{formatPaise(event.pricePaise)}</span>
        {event.capacity != null && <span>· {event.capacity} seats</span>}
      </div>
      <div className="mt-auto pt-4">
        <Button
          size="sm"
          loading={checkout.busy}
          onClick={() => {
            const prefill: { name?: string; contact?: string } = {};
            if (user?.displayName) prefill.name = user.displayName;
            if (user?.phoneNumber) prefill.contact = user.phoneNumber;
            void checkout.bookEventNow(event.id, event.pricePaise, prefill);
          }}
        >
          {isFree ? 'Register' : 'Book'}
        </Button>
      </div>
    </Card>
  );
}

function MembershipCard({ membership, checkout }: { membership: PublicMembership; checkout: Checkout }) {
  const { user } = useAuth();
  return (
    <Card className="flex h-full flex-col">
      <h3 className="text-base font-semibold text-[#0f172a]">{membership.name}</h3>
      {membership.description && (
        <p className="mt-1 text-sm text-[#475569] line-clamp-3">{membership.description}</p>
      )}
      <div className="mt-3 flex items-center gap-2 text-sm text-[#475569]">
        <span className="font-medium text-[#0f172a]">{formatPaise(membership.pricePaise)}</span>
        <span>· {membership.durationDays} days</span>
      </div>
      <div className="mt-auto pt-4">
        <Button
          size="sm"
          loading={checkout.busy}
          onClick={() => {
            const prefill: { name?: string; contact?: string } = {};
            if (user?.displayName) prefill.name = user.displayName;
            if (user?.phoneNumber) prefill.contact = user.phoneNumber;
            void checkout.buyMembershipNow(membership.id, membership.pricePaise, prefill);
          }}
        >
          Buy
        </Button>
      </div>
    </Card>
  );
}
