'use client';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { HScroll } from '@/components/HScroll';
import { VenueCard } from '@/components/cards/VenueCard';
import { EventCard } from '@/components/cards/EventCard';
import { MembershipCard } from '@/components/cards/MembershipCard';
import { useVenues, useUpcomingEvents, useAllMemberships } from '@/lib/api/consumer';
import { useLocation } from '@/lib/location/LocationProvider';
import { eventInRange, membershipInArea, venuesForArea } from '@/lib/location/geo';
import { Button } from '@/lib/ui';

const MOTIF: React.CSSProperties = {
  backgroundImage: 'radial-gradient(var(--color-ink) 1.5px, transparent 1.5px)',
  backgroundSize: '22px 22px',
};

export default function LandingPage() {
  const { city, country, coords, openPicker } = useLocation();
  // Fetch a wider set so location filtering still has cards to show, then cap to 10.
  const venues = useVenues('', 100);
  const events = useUpcomingEvents(100);
  const memberships = useAllMemberships(100);

  // Country is the market boundary; a selected city HARD-filters venues, so
  // this rail simply hides when the user's city has none.
  const nearbyVenues = venuesForArea(venues.data ?? [], { city, country }).slice(0, 10);
  const venuesTitle = city
    ? `Venues in ${city}`
    : country
      ? `Venues in ${country}`
      : 'Venues near you';
  // Shared location → only events within EVENT_RADIUS_KM; manual city pick or
  // no selection → country-wide, as before.
  const nearbyEvents = (events.data ?? [])
    .filter((e) => eventInRange(e, { city, country, coords }))
    .slice(0, 10);
  // Memberships: country boundary, city HARD filter for venue-scoped plans;
  // tenant-wide plans stay visible across the country.
  const nearbyMemberships = (memberships.data ?? [])
    .filter((m) => membershipInArea(m, { city, country }))
    .slice(0, 10);

  // With a location set and every rail empty, the page would be just the hero —
  // say why instead of rendering silence. Suppressed while queries load so the
  // message never flashes before the rails appear.
  const loading = venues.isLoading || events.isLoading || memberships.isLoading;
  const hasArea = Boolean(city || country || coords);
  const nothingNearby =
    !loading &&
    hasArea &&
    nearbyVenues.length === 0 &&
    nearbyEvents.length === 0 &&
    nearbyMemberships.length === 0;
  const nothingLabel = city ?? (coords ? 'your area' : country);

  return (
    <div className="min-h-screen">
      <Header />

      {/* Hero */}
      <section className="relative overflow-hidden border-b-[2.5px] border-ink bg-surface text-ink">
        <div className="pointer-events-none absolute inset-0 opacity-[0.06]" style={MOTIF} />
        <div className="relative mx-auto max-w-6xl px-4 py-16 sm:py-20">
          <p className="mb-3 font-accent text-2xl font-bold text-coral-deep">your people are out there ✦</p>
          <h1 className="max-w-2xl font-display text-5xl font-extrabold leading-[1.02] sm:text-6xl">
            Find your circle. <span className="text-coral-deep">Book your spot.</span>
          </h1>
          <p className="mt-4 max-w-lg text-base text-text-secondary">
            Because &ldquo;we should do this sometime&rdquo; deserves an actual time.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/venues"><Button variant="primary">Browse venues</Button></Link>
            <Link href="/events"><Button variant="secondary">See what&apos;s on →</Button></Link>
          </div>
        </div>
      </section>

      <main className="py-6">
        {nothingNearby && (
          <p className="mx-auto max-w-6xl px-4 py-10 text-center text-sm text-text-secondary">
            Nothing in <span className="font-semibold text-ink">{nothingLabel}</span> yet — check
            back soon.{' '}
            <button
              onClick={openPicker}
              className="font-semibold text-ink underline hover:text-coral-deep"
            >
              Change location
            </button>
          </p>
        )}
        {nearbyVenues.length > 0 && (
          <HScroll title={venuesTitle} viewAllHref="/venues">
            {nearbyVenues.map((v) => <VenueCard key={v.id} venue={v} className="w-[260px] shrink-0 snap-start" />)}
          </HScroll>
        )}

        {nearbyEvents.length > 0 && (
          <HScroll
            title={coords ? "What's on near you" : country ? `What's on in ${country}` : 'Upcoming events'}
            viewAllHref="/events"
          >
            {nearbyEvents.map((e) => <EventCard key={e.id} event={e} className="w-[260px] shrink-0 snap-start" />)}
          </HScroll>
        )}

        {nearbyMemberships.length > 0 && (
          <HScroll title={(city ?? country) ? `Memberships in ${city ?? country}` : 'Memberships'} viewAllHref="/memberships">
            {nearbyMemberships.map((m) => <MembershipCard key={m.id} membership={m} className="w-[260px] shrink-0 snap-start" />)}
          </HScroll>
        )}
      </main>
    </div>
  );
}
