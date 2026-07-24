'use client';
import { useParams } from 'next/navigation';
import { Header } from '@/components/Header';
import { BackBar } from '@/components/BackBar';
import { EmptyState } from '@/components/EmptyState';
import { OrgBrandBlock } from '@/components/OrgBrandBlock';
import { VenueCard } from '@/components/cards/VenueCard';
import { EventCard } from '@/components/cards/EventCard';
import { MembershipCard } from '@/components/cards/MembershipCard';
import {
  useAllMemberships,
  usePublicOrg,
  useUpcomingEvents,
  useVenues,
} from '@/lib/api/consumer';

/**
 * A single organiser's public profile: the trust card plus everything they
 * run on circls — venues, upcoming events and memberships. The public list
 * payloads all carry a brand summary, so the org's slice is filtered client-
 * side from the same queries the browse pages use.
 */
export default function OrgProfilePage() {
  const params = useParams<{ slug: string }>();
  const orgQ = usePublicOrg(params.slug);
  const org = orgQ.data;

  const venuesQ = useVenues('', 100);
  const eventsQ = useUpcomingEvents(100);
  const membershipsQ = useAllMemberships(100);

  const venues = (venuesQ.data ?? []).filter((v) => v.brand.slug === params.slug);
  const events = (eventsQ.data ?? []).filter((e) => e.brand.slug === params.slug);
  const memberships = (membershipsQ.data ?? []).filter((m) => m.brand.slug === params.slug);
  const listingsLoading = venuesQ.isLoading || eventsQ.isLoading || membershipsQ.isLoading;
  const nothingListed =
    !listingsLoading && venues.length === 0 && events.length === 0 && memberships.length === 0;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 pt-16 pb-8">
        <BackBar />

        {orgQ.isLoading ? (
          <p className="mt-6 text-sm text-text-secondary">Loading organisation…</p>
        ) : orgQ.isError || !org ? (
          <div className="mt-6">
            <EmptyState
              title="Organisation not found"
              body="This organiser may no longer be active. Browse the directory for who's on circls."
            />
          </div>
        ) : (
          <div className="mt-6">
            <h1 className="mb-6 font-display text-4xl font-extrabold text-ink">{org.name}</h1>
            <OrgBrandBlock
              brand={{ id: org.id, slug: org.slug, name: org.name, logoUrl: org.logoUrl }}
              org={org}
              label="Organiser"
              variant="full"
              className="max-w-2xl"
            />

            {listingsLoading ? (
              <p className="mt-10 text-sm text-text-secondary">Loading their venues and events…</p>
            ) : nothingListed ? (
              <p className="mt-10 text-sm text-text-secondary">
                Nothing bookable from {org.name} right now — check back soon.
              </p>
            ) : (
              <>
                {venues.length > 0 && (
                  <section className="mt-10">
                    <h2 className="mb-4 font-display text-2xl font-extrabold text-ink">Venues</h2>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {venues.map((v) => <VenueCard key={v.id} venue={v} />)}
                    </div>
                  </section>
                )}

                {events.length > 0 && (
                  <section className="mt-10">
                    <h2 className="mb-4 font-display text-2xl font-extrabold text-ink">Upcoming events</h2>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {events.map((e) => <EventCard key={e.id} event={e} />)}
                    </div>
                  </section>
                )}

                {memberships.length > 0 && (
                  <section className="mt-10">
                    <h2 className="mb-4 font-display text-2xl font-extrabold text-ink">Memberships</h2>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {memberships.map((m) => <MembershipCard key={m.id} membership={m} />)}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
