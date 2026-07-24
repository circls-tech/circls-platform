'use client';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { VenueCard } from '@/components/cards/VenueCard';
import { CardSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useVenues } from '@/lib/api/consumer';
import { useLocation } from '@/lib/location/LocationProvider';
import { venuesForArea } from '@/lib/location/geo';
import { Input } from '@/lib/ui';

export default function VenuesPage() {
  const [search, setSearch] = useState('');
  const { city, country, coords, openPicker } = useLocation();
  // Country is the market boundary; a selected city is a HARD filter; shared
  // coords without a city (user outside every served city) restrict geolocated
  // venues to the nearby radius, mirroring events. The label prefers the CITY,
  // says "near you" in radius mode, and falls back to the country.
  const nearYou = Boolean(coords) && !city;
  const areaLabel = city ?? (nearYou ? 'near you' : country);
  const venues = useVenues(search);
  const filtered = venuesForArea(venues.data ?? [], { city, country, coords });

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 pt-16 pb-8">
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
                Showing venues {nearYou ? '' : 'in '}
                <span className="font-semibold text-ink">{areaLabel}</span>.{' '}
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
            title="No venues here yet"
            body={
              areaLabel
                ? `No venues ${city ? `in ${city}` : areaLabel === 'near you' ? 'near you' : `in ${areaLabel}`} yet. Check back soon, or change your location to browse elsewhere.`
                : 'Try a different search, or check back soon — new venues are added often.'
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((v) => (
              <VenueCard key={v.id} venue={v} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
