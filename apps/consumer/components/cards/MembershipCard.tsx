import Link from 'next/link';
import { LikeButton } from '@/components/LikeButton';
import { SportImage } from '@/components/SportImage';
import { currencyForCountry, formatPaise } from '@/lib/format';
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
    // The heart is a sibling of the link, not a child: a button inside an
    // anchor is invalid HTML, and this keeps the whole card clickable.
    <div className={`relative ${className}`}>
    <Link
      href={href}
      className="block h-full overflow-hidden rounded-card border-[2px] border-ink bg-lav text-ink shadow-offset-sm transition-[transform,box-shadow] duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset"
    >
      {/* Always a header band, even with no artwork: SportImage falls back to
          the court-line motif. Rendering nothing left a plan without a photo
          starting at a different height from one beside it, and — since the
          grid stretches both — trailing a block of empty lavender. */}
      <SportImage
        input={{ imageUrl: membership.artworkUrl ?? null, tags: membership.venueTags }}
        alt={membership.name}
        className="h-28 w-full border-b-[2px] border-ink"
      />
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
          {(membership.tiers?.length ?? 0) > 1 && (
            <span className="font-sans text-xs font-medium text-ink-soft">from </span>
          )}
          {formatPaise(membership.pricePaise, currencyForCountry(membership.country))}{' '}
          <span className="font-sans text-xs font-medium text-ink-soft">/ {membership.durationDays} days</span>
        </div>
        <span className="mt-3 inline-block rounded-lg border-[2px] border-ink bg-coral px-3.5 py-1.5 font-display text-xs font-bold text-ink shadow-offset-sm">
          View
        </span>
      </div>
    </Link>
      <LikeButton itemType="membership" itemId={membership.id} name={membership.name} className="absolute right-2.5 top-2.5 z-10" />
    </div>
  );
}
