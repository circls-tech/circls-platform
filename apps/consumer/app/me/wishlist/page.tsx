'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Header } from '@/components/Header';
import { BackBar } from '@/components/BackBar';
import { EmptyState } from '@/components/EmptyState';
import { CardSkeleton } from '@/components/Skeleton';
import { EventCard } from '@/components/cards/EventCard';
import { MembershipCard } from '@/components/cards/MembershipCard';
import { VenueCard } from '@/components/cards/VenueCard';
import { useWishlist } from '@/lib/api/wishlist';
import { useAuth } from '@/lib/firebase/auth_context';
import { Button } from '@/lib/ui';

const GRID = 'grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3';

/**
 * Everything the signed-in user has liked — events, venues and membership
 * plans — as the same cards the browse pages use, so a tap on the heart here
 * removes the item the same way it was added. Only listings the catalogue
 * still shows are returned; a liked event that has passed simply drops off.
 */
export default function WishlistPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const wishlist = useWishlist();

  useEffect(() => {
    if (!loading && !user) router.replace('/login?redirect=/me/wishlist');
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-6xl px-4 py-8">
          <p className="text-sm text-text-secondary">Loading…</p>
        </main>
      </div>
    );
  }

  const data = wishlist.data;
  const total = data ? data.events.length + data.venues.length + data.memberships.length : 0;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <BackBar fallbackHref="/" />
        <h1 className="mb-1 font-display text-4xl font-extrabold text-ink">Wishlist</h1>
        <p className="mb-8 text-sm text-text-secondary">
          Events, venues and memberships you&apos;ve saved to check out later. Tap the heart on
          anything to add it here.
        </p>

        {wishlist.isLoading ? (
          <div className={GRID}>
            {Array.from({ length: 3 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : wishlist.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {wishlist.error instanceof Error ? wishlist.error.message : 'Failed to load your wishlist'}
          </p>
        ) : !data || total === 0 ? (
          <EmptyState
            title="Nothing saved yet"
            body="Spot something you like? Tap the heart on an event, venue or membership and it'll wait for you here."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link href="/events"><Button size="sm">Browse events</Button></Link>
                <Link href="/venues"><Button size="sm" variant="secondary">Browse venues</Button></Link>
                <Link href="/memberships"><Button size="sm" variant="secondary">Browse memberships</Button></Link>
              </div>
            }
          />
        ) : (
          <div className="space-y-10">
            {data.events.length > 0 && (
              <section>
                <h2 className="mb-3 font-display text-xl font-extrabold text-ink">
                  Events <span className="text-text-secondary">· {data.events.length}</span>
                </h2>
                <div className={GRID}>
                  {data.events.map((e) => <EventCard key={e.id} event={e} />)}
                </div>
              </section>
            )}
            {data.venues.length > 0 && (
              <section>
                <h2 className="mb-3 font-display text-xl font-extrabold text-ink">
                  Venues <span className="text-text-secondary">· {data.venues.length}</span>
                </h2>
                <div className={GRID}>
                  {data.venues.map((v) => <VenueCard key={v.id} venue={v} />)}
                </div>
              </section>
            )}
            {data.memberships.length > 0 && (
              <section>
                <h2 className="mb-3 font-display text-xl font-extrabold text-ink">
                  Memberships <span className="text-text-secondary">· {data.memberships.length}</span>
                </h2>
                <div className={GRID}>
                  {data.memberships.map((m) => <MembershipCard key={m.id} membership={m} />)}
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
