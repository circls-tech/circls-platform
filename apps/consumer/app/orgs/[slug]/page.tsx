'use client';
import { useParams } from 'next/navigation';
import { Header } from '@/components/Header';
import { BackBar } from '@/components/BackBar';
import { EmptyState } from '@/components/EmptyState';
import { OrgBrandBlock } from '@/components/OrgBrandBlock';
import { usePublicOrg } from '@/lib/api/consumer';

/** A single organiser's public profile page. */
export default function OrgProfilePage() {
  const params = useParams<{ slug: string }>();
  const orgQ = usePublicOrg(params.slug);
  const org = orgQ.data;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-4xl px-4 pt-16 pb-8">
        <BackBar />

        {orgQ.isLoading ? (
          <p className="mt-6 text-sm text-text-secondary">Loading organisation…</p>
        ) : orgQ.isError || !org ? (
          <div className="mt-6">
            <EmptyState
              title="Organisation not found"
              body="This organiser may no longer be active. Browse the directory for who's on circls."
            />
          </div>
        ) : (
          <div className="mt-6">
            <h1 className="mb-6 font-display text-4xl font-extrabold text-ink">{org.name}</h1>
            <OrgBrandBlock
              brand={{ id: org.id, slug: org.slug, name: org.name, logoUrl: org.logoUrl }}
              org={org}
              label="Organiser"
              variant="full"
            />
          </div>
        )}
      </main>
    </div>
  );
}
