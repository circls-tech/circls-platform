import Link from 'next/link';
import type { PublicOrgSummary } from '@/lib/api/types';
import { petalFor } from '@/lib/petals';

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
      style={{ backgroundColor: petalFor(name) }}
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border-[2px] border-ink font-display text-lg font-extrabold text-ink"
    >
      {initial}
    </span>
  );
}

/** Organiser card — landing rail + the /orgs directory grid. */
export function OrgCard({ org, className = '' }: { org: PublicOrgSummary; className?: string }) {
  const place = [org.city, org.country].filter(Boolean).join(', ');
  return (
    <Link
      href={`/orgs/${org.slug}`}
      className={`block rounded-card border-[2px] border-ink bg-white p-4 shadow-offset-sm transition-[transform,box-shadow] duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset ${className}`}
    >
      <div className="flex items-start gap-3">
        <OrgLogo name={org.name} logoUrl={org.logoUrl} />
        <div className="min-w-0">
          <h3 className="truncate font-display text-lg font-extrabold text-ink">{org.name}</h3>
          {place && <p className="text-xs font-semibold text-ink-soft">{place}</p>}
          {org.description && (
            <p className="mt-1 line-clamp-2 text-sm text-text-secondary">{org.description}</p>
          )}
        </div>
      </div>
    </Link>
  );
}
