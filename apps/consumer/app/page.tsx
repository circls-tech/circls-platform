'use client';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { HScroll } from '@/components/HScroll';
import { VenueCard } from '@/components/cards/VenueCard';
import { EventCard } from '@/components/cards/EventCard';
import { MembershipCard } from '@/components/cards/MembershipCard';
import { useVenues, useUpcomingEvents, useAllMemberships } from '@/lib/api/consumer';
import { Button } from '@/lib/ui';

const MOTIF: React.CSSProperties = {
  backgroundImage: 'radial-gradient(var(--color-ink) 1.5px, transparent 1.5px)',
  backgroundSize: '22px 22px',
};

export default function LandingPage() {
  const venues = useVenues('', 10);
  const events = useUpcomingEvents(10);
  const memberships = useAllMemberships(10);

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
        {(venues.data?.length ?? 0) > 0 && (
          <HScroll title="Venues near you" viewAllHref="/venues">
            {venues.data!.map((v) => <VenueCard key={v.id} venue={v} className="w-[260px] shrink-0 snap-start" />)}
          </HScroll>
        )}

        {(events.data?.length ?? 0) > 0 && (
          <HScroll title="Upcoming events" viewAllHref="/events">
            {events.data!.map((e) => <EventCard key={e.id} event={e} className="w-[260px] shrink-0 snap-start" />)}
          </HScroll>
        )}

        {(memberships.data?.length ?? 0) > 0 && (
          <HScroll title="Memberships" viewAllHref="/memberships">
            {memberships.data!.map((m) => <MembershipCard key={m.id} membership={m} className="w-[260px] shrink-0 snap-start" />)}
          </HScroll>
        )}
      </main>
    </div>
  );
}
