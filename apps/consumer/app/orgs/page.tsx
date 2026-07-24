'use client';
import { Header } from '@/components/Header';
import { EmptyState } from '@/components/EmptyState';
import { OrgCard } from '@/components/cards/OrgCard';
import { usePublicOrgs } from '@/lib/api/consumer';

/** The public organisers directory — every active org on the platform. */
export default function OrgsPage() {
  const orgs = usePublicOrgs();

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 pt-16 pb-8">
        <h1 className="font-display text-4xl font-extrabold text-ink">Organisations</h1>
        <p className="mt-1 mb-6 text-sm text-text-secondary">
          The clubs and organisers running venues, events and memberships on circls.
        </p>

        {orgs.isLoading ? (
          <p className="text-sm text-text-secondary">Loading organisations…</p>
        ) : orgs.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {orgs.error instanceof Error ? orgs.error.message : 'Failed to load organisations'}
          </p>
        ) : !orgs.data || orgs.data.length === 0 ? (
          <EmptyState title="No organisations yet" body="Check back soon — new organisers join often." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {orgs.data.map((org) => <OrgCard key={org.id} org={org} />)}
          </div>
        )}
      </main>
    </div>
  );
}
