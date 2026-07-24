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

/**
 * The signed-in user's membership purchases — the membership slice of the
 * bookings feed (`itemType === 'membership'`), linked from the profile menu.
 */
export default function MyMembershipsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const bookings = useMyBookings();

  useEffect(() => {
    if (!loading && !user) router.replace('/login?redirect=/me/memberships');
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-4xl px-4 py-8">
          <p className="text-sm text-text-secondary">Loading…</p>
        </main>
      </div>
    );
  }

  const memberships = (bookings.data ?? []).filter((b) => b.itemType === 'membership');

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="mb-6 font-display text-4xl font-extrabold text-ink">My memberships</h1>

        {bookings.isLoading ? (
          <p className="text-sm text-text-secondary">Loading your memberships…</p>
        ) : bookings.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {bookings.error instanceof Error ? bookings.error.message : 'Failed to load memberships'}
          </p>
        ) : memberships.length === 0 ? (
          <EmptyState title="No memberships yet" body="When you buy a membership, it'll show up here." />
        ) : (
          <div className="flex flex-col gap-3">
            {memberships.map((b) => (
              <Link
                key={b.id}
                href={`/me/bookings/${b.id}`}
                className="block rounded-card outline-none transition-transform duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-coral-deep"
              >
                <Card>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="font-display text-lg font-extrabold text-ink">{b.venueName}</h2>
                      <p className="mt-0.5 text-sm text-text-secondary">
                        Membership · {formatDate(b.createdAt)}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <StatusPill status={b.status} />
                      <span className="text-sm font-medium text-ink">
                        {formatPaise(b.totalPaise, b.currency)}
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
