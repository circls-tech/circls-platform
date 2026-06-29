import Link from 'next/link';
import { formatPaise } from '@/lib/format';
import { membershipScope } from '@/lib/trust';
import type { PublicMembershipWithScope } from '@/lib/api/types';

/** Small org logo / initials chip used in the card byline. */
function BrandChip({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={`${name} logo`}
        loading="lazy"
        className="h-5 w-5 shrink-0 rounded border-[1.5px] border-ink object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded border-[1.5px] border-ink bg-white text-[10px] font-extrabold text-ink"
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function MembershipCard({
  membership,
  className = '',
}: {
  membership: PublicMembershipWithScope;
  className?: string;
}) {
  const href = `/memberships/${membership.id}`;
  const scope = membershipScope(membership);
  const brand = membership.brand;
  return (
    <Link
      href={href}
      className={`block overflow-hidden rounded-card border-[2.5px] border-ink bg-lav text-ink shadow-offset-sm transition-[transform,box-shadow] duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset ${className}`}
    >
      {membership.artworkUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={membership.artworkUrl}
          alt={membership.name}
          loading="lazy"
          className="h-28 w-full border-b-[2.5px] border-ink object-cover"
        />
      )}
      <div className="p-4">
        {brand && (
          <div className="mb-2 flex items-center gap-1.5">
            <BrandChip name={brand.name} logoUrl={brand.logoUrl} />
            <span className="truncate text-xs font-semibold text-ink-soft">{brand.name}</span>
          </div>
        )}
        <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ink-soft">
          {scope.label}
        </p>
        <h3 className="font-display text-[19px] font-extrabold">{membership.name}</h3>
        {membership.description && (
          <p className="mt-1 line-clamp-2 text-xs text-ink-soft">{membership.description}</p>
        )}
        <div className="mt-3 font-display text-2xl font-extrabold">
          {formatPaise(membership.pricePaise)}{' '}
          <span className="font-sans text-xs font-medium text-ink-soft">/ {membership.durationDays} days</span>
        </div>
        <span className="mt-3 inline-block rounded-lg border-[2px] border-ink bg-coral px-3.5 py-1.5 font-display text-xs font-bold text-ink shadow-offset-sm">
          View
        </span>
      </div>
    </Link>
  );
}
