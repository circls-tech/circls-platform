'use client';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { VenueCard } from '@/components/cards/VenueCard';
import { CardSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useVenues } from '@/lib/api/consumer';
import { useLocation } from '@/lib/location/LocationProvider';
import { inArea } from '@/lib/location/geo';
import { Input } from '@/lib/ui';

export default function VenuesPage() {
  const [search, setSearch] = useState('');
  const { city, country, openPicker } = useLocation();
  const areaLabel = city ?? country;
  const venues = useVenues(search);
  const filtered = (venues.data ?? []).filter((v) => inArea(v.addressJson, { city, country }));

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8 max-w-xl">
          <h1 className="font-display text-4xl font-extrabold text-ink">Find a venue</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Book courts and turfs, join events, and grab memberships near you.
          </p>
          <div className="mt-4">
            <Input
              placeholder="Search by name or sport…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search venues"
            />
          </div>
          <p className="mt-3 text-sm text-text-secondary">
            {areaLabel ? (
              <>
                Showing venues in <span className="font-semibold text-ink">{areaLabel}</span>.{' '}
                <button onClick={openPicker} className="font-semibold text-ink underline hover:text-coral-deep">
                  Change
                </button>
              </>
            ) : (
              <button onClick={openPicker} className="font-semibold text-ink underline hover:text-coral-deep">
                📍 Set your location
              </button>
            )}
          </p>
        </div>

        {venues.isLoading ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : venues.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {venues.error instanceof Error ? venues.error.message : 'Failed to load venues'}
          </p>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No venues found"
            body={
              areaLabel
                ? `No venues in ${areaLabel} match your search. Try changing your location or search.`
                : 'Try a different search, or check back soon — new venues are added often.'
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((v) => <VenueCard key={v.id} venue={v} />)}
          </div>
        )}
      </main>
    </div>
  );
}
