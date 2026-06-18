'use client';
import { Header } from '@/components/Header';
import { MembershipCard } from '@/components/cards/MembershipCard';
import { CardSkeleton } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useAllMemberships } from '@/lib/api/consumer';

export default function MembershipsPage() {
  const memberships = useAllMemberships(100);
  const rows = memberships.data ?? [];

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-1 font-display text-3xl font-semibold text-ink">Memberships</h1>
        <p className="mb-8 text-sm text-text-secondary">Plans and passes across every venue.</p>

        {memberships.isLoading ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : memberships.isError ? (
          <p className="text-sm text-red-600">
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
