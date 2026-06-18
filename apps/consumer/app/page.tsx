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
  backgroundImage:
    'linear-gradient(var(--color-gold-500) 2px, transparent 2px), linear-gradient(90deg, var(--color-gold-500) 2px, transparent 2px)',
  backgroundSize: '46px 46px',
};

export default function LandingPage() {
  const venues = useVenues('', 10);
  const events = useUpcomingEvents(10);
  const memberships = useAllMemberships(10);

  return (
    <div className="min-h-screen">
      <Header />

      {/* Hero */}
      <section className="relative overflow-hidden bg-gradient-to-br from-ink-deep to-ink-soft text-white">
        <div className="absolute inset-0 opacity-10" style={MOTIF} />
        <div className="relative mx-auto max-w-6xl px-4 py-16 sm:py-20">
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-gold-500">Welcome to circls</p>
          <h1 className="max-w-2xl font-display text-4xl font-semibold leading-[1.05] sm:text-5xl">
            Find your circle. <span className="text-gold-500">Book your spot.</span>
          </h1>
          <p className="mt-3 max-w-lg text-base text-white/80">
            Because &ldquo;we should do this sometime&rdquo; deserves an actual time.
          </p>
          <div className="mt-6 flex gap-3">
            <Link href="/venues"><Button variant="accent">Browse venues</Button></Link>
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
