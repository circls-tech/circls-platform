'use client';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { VenueCard } from '@/components/cards/VenueCard';
import { CardSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useVenues } from '@/lib/api/consumer';
import { Input } from '@/lib/ui';

export default function VenuesPage() {
  const [search, setSearch] = useState('');
  const venues = useVenues(search);

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8 max-w-xl">
          <h1 className="font-display text-3xl font-semibold text-ink">Find a venue</h1>
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
        </div>

        {venues.isLoading ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : venues.isError ? (
          <p className="text-sm text-red-600">
            {venues.error instanceof Error ? venues.error.message : 'Failed to load venues'}
          </p>
        ) : !venues.data || venues.data.length === 0 ? (
          <EmptyState title="No venues found" body="Try a different search, or check back soon — new venues are added often." />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {venues.data.map((v) => <VenueCard key={v.id} venue={v} />)}
          </div>
        )}
      </main>
    </div>
  );
}
