'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { BackBar } from '@/components/BackBar';
import { EmptyState } from '@/components/EmptyState';
import { CardSkeleton } from '@/components/Skeleton';
import { SearchBar } from '@/components/SearchBar';
import { EventCard } from '@/components/cards/EventCard';
import { MembershipCard } from '@/components/cards/MembershipCard';
import { VenueCard } from '@/components/cards/VenueCard';
import { useSearch } from '@/lib/api/consumer';
import { useLocation } from '@/lib/location/LocationProvider';
import { eventInRange, membershipInArea, venuesForArea } from '@/lib/location/geo';
import {
  normaliseQuery,
  parseScope,
  searchHref,
  SCOPE_LABELS,
  SEARCH_TYPES,
  type SearchScope,
} from '@/lib/search';
import { Button } from '@/lib/ui';

const GRID = 'grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3';
/** Keystrokes settle for this long before the URL (and the query) follow. */
const DEBOUNCE_MS = 300;
const SCOPES: SearchScope[] = ['all', ...SEARCH_TYPES];

/**
 * `/search?q=…&type=…` — one term across events, venues and memberships,
 * matched by name (and by the venue or organiser a listing belongs to). The
 * term and the section filter live in the URL so a result list survives a
 * refresh and the back button; typing updates them after a short pause.
 * Results honour the location pin like every browse page, with a one-tap
 * escape hatch to see matches everywhere.
 */
function SearchInner() {
  const params = useSearchParams();
  const router = useRouter();
  const q = normaliseQuery(params.get('q'));
  const scope = parseScope(params.get('type'));
  const { city, country, coords, openPicker } = useLocation();

  const [draft, setDraft] = useState(q);
  const [everywhere, setEverywhere] = useState(false);
  // The URL changed under us (header search, back/forward): follow it. When
  // the change is our own debounced replace, the draft already normalises
  // to `q`; leave it alone so a trailing space the user is mid-way through
  // typing ('turf ' → 'turf park') isn't trimmed out from under them.
  useEffect(() => {
    setDraft((d) => (normaliseQuery(d) === q ? d : q));
  }, [q]);
  // Debounced the other way: the draft settles → the URL follows.
  useEffect(() => {
    const next = normaliseQuery(draft);
    if (next === q) return;
    const t = setTimeout(() => router.replace(searchHref(next, scope)), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft, q, scope, router]);

  const results = useSearch(q, scope);
  const data = results.data;
  const sel = { city, country, coords };
  const nearYou = Boolean(coords) && !city;
  const areaLabel = city ?? (nearYou ? 'near you' : country);
  const hasArea = Boolean(areaLabel) && !everywhere;

  const events = data ? (hasArea ? data.events.filter((e) => eventInRange(e, sel)) : data.events) : [];
  const venues = data ? (hasArea ? venuesForArea(data.venues, sel) : data.venues) : [];
  const memberships = data
    ? hasArea
      ? data.memberships.filter((m) => membershipInArea(m, sel))
      : data.memberships
    : [];
  const shown = events.length + venues.length + memberships.length;
  const fetched = data ? data.events.length + data.venues.length + data.memberships.length : 0;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <BackBar fallbackHref="/" />
        <h1 className="mb-1 font-display text-4xl font-extrabold text-ink">Search</h1>
        <p className="mb-5 text-sm text-text-secondary">
          Find an event, a venue or a membership by name.
        </p>

        <div className="max-w-xl">
          <SearchBar value={draft} onChange={setDraft} scope={scope} autoFocus />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Show">
          {SCOPES.map((s) => {
            const active = s === scope;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={active}
                onClick={() => router.replace(searchHref(q, s))}
                className={[
                  'rounded-xl border-[2px] border-ink px-3.5 py-1.5 text-xs font-bold',
                  active ? 'bg-coral text-ink shadow-offset-sm' : 'bg-white text-ink hover:bg-surface-2',
                ].join(' ')}
              >
                {SCOPE_LABELS[s]}
              </button>
            );
          })}
        </div>

        <p className="mt-3 text-sm text-text-secondary">
          {everywhere ? (
            <>
              Showing matches everywhere.{' '}
              <button onClick={() => setEverywhere(false)} className="font-semibold text-ink underline hover:text-coral-deep">
                Only {areaLabel ?? 'my area'}
              </button>
            </>
          ) : areaLabel ? (
            <>
              Matches {nearYou ? '' : 'in '}
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

        <div className="mt-8">
          {!q ? (
            <EmptyState
              title="What are you looking for?"
              body="Try a sport, a venue, an organiser or the name of an event or pass."
            />
          ) : results.isLoading ? (
            <div className={GRID}>
              {Array.from({ length: 3 }).map((_, i) => <CardSkeleton key={i} />)}
            </div>
          ) : results.isError ? (
            <p className="text-sm font-semibold text-petal-red">
              {results.error instanceof Error ? results.error.message : 'Search failed'}
            </p>
          ) : shown === 0 ? (
            fetched > 0 ? (
              <EmptyState
                title={`Nothing for “${q}” ${city ? `in ${city}` : nearYou ? 'near you' : `in ${areaLabel}`}`}
                body={`There ${fetched === 1 ? 'is 1 match' : `are ${fetched} matches`} elsewhere.`}
                action={<Button size="sm" onClick={() => setEverywhere(true)}>Show matches everywhere</Button>}
              />
            ) : (
              <EmptyState
                title={`Nothing for “${q}”`}
                body="Check the spelling, try a shorter term, or search by venue or organiser name."
              />
            )
          ) : (
            <div className={`space-y-10 ${results.isFetching ? 'opacity-60' : ''}`}>
              {events.length > 0 && (
                <section>
                  <h2 className="mb-3 font-display text-xl font-extrabold text-ink">
                    Events <span className="text-text-secondary">· {events.length}</span>
                  </h2>
                  <div className={GRID}>
                    {events.map((e) => <EventCard key={e.id} event={e} />)}
                  </div>
                </section>
              )}
              {venues.length > 0 && (
                <section>
                  <h2 className="mb-3 font-display text-xl font-extrabold text-ink">
                    Venues <span className="text-text-secondary">· {venues.length}</span>
                  </h2>
                  <div className={GRID}>
                    {venues.map((v) => <VenueCard key={v.id} venue={v} />)}
                  </div>
                </section>
              )}
              {memberships.length > 0 && (
                <section>
                  <h2 className="mb-3 font-display text-xl font-extrabold text-ink">
                    Memberships <span className="text-text-secondary">· {memberships.length}</span>
                  </h2>
                  <div className={GRID}>
                    {memberships.map((m) => <MembershipCard key={m.id} membership={m} />)}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function SearchPage() {
  // useSearchParams requires a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <SearchInner />
    </Suspense>
  );
}
