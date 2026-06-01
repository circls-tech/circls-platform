'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Header } from '@/components/Header';
import { EmptyState } from '@/components/EmptyState';
import { useMyBookings } from '@/lib/api/consumer';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatDate, formatPaise } from '@/lib/format';
import { Card, StatusPill } from '@/lib/ui';

const ITEM_TYPE_LABELS: Record<string, string> = {
  slot: 'Court booking',
  event: 'Event',
  membership: 'Membership',
};

export default function MyBookingsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const bookings = useMyBookings();

  useEffect(() => {
    if (!loading && !user) router.replace('/login?redirect=/me/bookings');
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-3xl px-4 py-8">
          <p className="text-sm text-text-secondary">Loading…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 font-display text-3xl font-semibold text-ink">My bookings</h1>

        {bookings.isLoading ? (
          <p className="text-sm text-text-secondary">Loading your bookings…</p>
        ) : bookings.isError ? (
          <p className="text-sm text-red-600">
            {bookings.error instanceof Error ? bookings.error.message : 'Failed to load bookings'}
          </p>
        ) : !bookings.data || bookings.data.length === 0 ? (
          <EmptyState title="No bookings yet" body="When you book a court, join an event, or buy a membership, it'll show up here." />
        ) : (
          <div className="flex flex-col gap-3">
            {bookings.data.map((b) => (
              <Link
                key={b.id}
                href={`/me/bookings/${b.id}`}
                className="block rounded-card outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-gold-600"
              >
                <Card>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="font-display text-base font-semibold text-ink">{b.venueName}</h2>
                      <p className="mt-0.5 text-sm text-text-secondary">
                        {ITEM_TYPE_LABELS[b.itemType] ?? b.itemType} · {formatDate(b.createdAt)}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <StatusPill status={b.status} />
                      <span className="text-sm font-medium text-ink">
                        {formatPaise(b.totalPaise)}
                      </span>
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
