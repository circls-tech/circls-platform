'use client';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { EmptyState } from '@/components/EmptyState';
import { usePublicOrgs } from '@/lib/api/consumer';
import { Card } from '@/lib/ui';

/** Square org logo, or a coloured initials chip when no logo is uploaded. */
function OrgLogo({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={`${name} logo`}
        loading="lazy"
        className="h-12 w-12 shrink-0 rounded-lg border-[2px] border-ink object-cover"
      />
    );
  }
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border-[2px] border-ink bg-lav font-display text-lg font-extrabold text-ink"
    >
      {initial}
    </span>
  );
}

/** The public organisers directory — every active org on the platform. */
export default function OrgsPage() {
  const orgs = usePublicOrgs();

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-4 py-8">
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
            {orgs.data.map((org) => (
              <Link
                key={org.id}
                href={`/orgs/${org.slug}`}
                className="block rounded-card outline-none transition-transform duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-coral-deep"
              >
                <Card className="h-full">
                  <div className="flex items-start gap-3">
                    <OrgLogo name={org.name} logoUrl={org.logoUrl} />
                    <div className="min-w-0">
                      <h2 className="truncate font-display text-lg font-extrabold text-ink">{org.name}</h2>
                      {(org.city || org.country) && (
                        <p className="text-xs font-semibold text-ink-soft">
                          {[org.city, org.country].filter(Boolean).join(', ')}
                        </p>
                      )}
                      {org.description && (
                        <p className="mt-1 line-clamp-2 text-sm text-text-secondary">{org.description}</p>
                      )}
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
