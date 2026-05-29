'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Header } from '@/components/Header';
import { useVenues } from '@/lib/api/consumer';
import { Badge, Card, Input } from '@/lib/ui';

export default function HomePage() {
  const [search, setSearch] = useState('');
  const venues = useVenues(search);

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-8 max-w-xl">
          <h1 className="text-2xl font-semibold text-[#0f172a]">Find a venue</h1>
          <p className="mt-1 text-sm text-[#475569]">
            Book courts and turfs, join events, and buy memberships near you.
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
          <p className="text-sm text-[#475569]">Loading venues…</p>
        ) : venues.isError ? (
          <p className="text-sm text-red-600">
            {venues.error instanceof Error ? venues.error.message : 'Failed to load venues'}
          </p>
        ) : !venues.data || venues.data.length === 0 ? (
          <p className="text-sm text-[#475569]">No venues found.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {venues.data.map((v) => (
              <Link key={v.id} href={`/venues/${v.id}`} className="block">
                <Card className="h-full transition-shadow hover:shadow-md">
                  <h2 className="text-base font-semibold text-[#0f172a]">{v.name}</h2>
                  {v.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {v.tags.slice(0, 6).map((tag) => (
                        <Badge key={tag} tone="neutral" label={tag} />
                      ))}
                    </div>
                  )}
                </Card>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
