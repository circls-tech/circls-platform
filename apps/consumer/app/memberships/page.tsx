'use client';
import { Header } from '@/components/Header';
import { MembershipCard } from '@/components/cards/MembershipCard';
import { CardSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useAllMemberships } from '@/lib/api/consumer';
import { useLocation } from '@/lib/location/LocationProvider';
import { membershipInArea } from '@/lib/location/geo';

export default function MembershipsPage() {
  const { city, country, coords, openPicker } = useLocation();
  const memberships = useAllMemberships(100);
  // Country is the market boundary; a selected city HARD-filters venue-scoped
  // plans by their venue's city, and shared coords without a city restrict
  // them to the nearby radius. Tenant-wide plans stay visible across the
  // country — a brand pass isn't city-bound. The label prefers the CITY, says
  // "near you" in radius mode, and falls back to the country.
  const nearYou = Boolean(coords) && !city;
  const areaLabel = city ?? (nearYou ? 'near you' : country);
  const rows = (memberships.data ?? []).filter((m) =>
    membershipInArea(m, { city, country, coords }),
  );

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="mb-1 font-display text-4xl font-extrabold text-ink">Memberships</h1>
        <p className="mb-8 text-sm text-text-secondary">
          {areaLabel ? (
            <>
              Plans and passes {nearYou ? '' : 'in '}
              <span className="font-semibold text-ink">{areaLabel}</span>.{' '}
              <button onClick={openPicker} className="font-semibold text-ink underline hover:text-coral-deep">
                Change
              </button>
            </>
          ) : (
            'Plans and passes across every country.'
          )}
        </p>

        {memberships.isLoading ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : memberships.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {memberships.error instanceof Error ? memberships.error.message : 'Failed to load memberships'}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState title="No memberships yet" body="There are no memberships available right now. Check back soon." />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((m) => <MembershipCard key={m.id} membership={m} />)}
          </div>
        )}
      </main>
    </div>
  );
}
