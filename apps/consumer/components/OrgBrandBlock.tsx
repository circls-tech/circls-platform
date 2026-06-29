import type { Brand, PublicOrg } from '@/lib/api/types';
import { formatAddress, socialLinks } from '@/lib/trust';

/** Square org logo, or a coloured initials chip when no logo is uploaded. */
function OrgLogo({ brand, size }: { brand: Brand; size: 'sm' | 'lg' }) {
  const dim = size === 'lg' ? 'h-14 w-14' : 'h-9 w-9';
  if (brand.logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={brand.logoUrl}
        alt={`${brand.name} logo`}
        loading="lazy"
        className={`${dim} shrink-0 rounded-lg border-[2px] border-ink object-cover`}
      />
    );
  }
  const initial = brand.name.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      aria-hidden
      className={`${dim} flex shrink-0 items-center justify-center rounded-lg border-[2px] border-ink bg-lav font-display font-extrabold text-ink`}
    >
      {initial}
    </span>
  );
}

/**
 * Shared org/brand "trust block". Two shapes:
 *  - `variant="byline"` (default): a compact "{label} {name}" row with the logo
 *    and an optional one-line description. Used on venue & event detail.
 *  - `variant="full"`: a card with logo, name, description, structured address,
 *    contact and website/socials. Used on the membership detail page.
 *
 * `brand` (the compact summary on every public payload) is required; `org` (the
 * full PublicOrg profile from usePublicOrg) is optional and enriches the block
 * when present. Everything degrades gracefully when fields are missing, and the
 * org name links out to the org's website when one is known.
 */
export function OrgBrandBlock({
  brand,
  label,
  org,
  variant = 'byline',
  className = '',
}: {
  brand: Brand | null | undefined;
  label?: string;
  org?: PublicOrg | null;
  variant?: 'byline' | 'full';
  className?: string;
}) {
  if (!brand) return null;

  const website = org?.websiteUrl ?? null;
  const nameClasses = 'font-display font-extrabold text-ink';
  const name = website ? (
    <a href={website} target="_blank" rel="noreferrer" className={`${nameClasses} underline decoration-coral decoration-2 underline-offset-2`}>
      {brand.name}
    </a>
  ) : (
    <span className={nameClasses}>{brand.name}</span>
  );

  if (variant === 'byline') {
    return (
      <div className={`flex items-center gap-3 ${className}`}>
        <OrgLogo brand={brand} size="sm" />
        <div className="min-w-0">
          {label && (
            <p className="text-[11px] font-bold uppercase tracking-widest text-ink-soft">{label}</p>
          )}
          <p className="truncate text-sm">{name}</p>
          {org?.description && (
            <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary">{org.description}</p>
          )}
        </div>
      </div>
    );
  }

  // variant === 'full'
  const address = formatAddress(org?.address);
  const socials = socialLinks(org?.socials);
  const email = org?.contactEmail ?? null;
  const phone = org?.contactPhone ?? null;

  return (
    <div className={`rounded-card border-[2.5px] border-ink bg-white p-5 shadow-offset ${className}`}>
      <div className="flex items-start gap-3">
        <OrgLogo brand={brand} size="lg" />
        <div className="min-w-0">
          {label && (
            <p className="text-[11px] font-bold uppercase tracking-widest text-ink-soft">{label}</p>
          )}
          <p className="text-lg">{name}</p>
          {org?.description && (
            <p className="mt-1 text-sm text-text-secondary">{org.description}</p>
          )}
        </div>
      </div>

      {(address || email || phone) && (
        <dl className="mt-4 space-y-1.5 text-sm">
          {address && (
            <div className="flex gap-2">
              <dt className="shrink-0 text-ink-soft">Address</dt>
              <dd className="text-text-secondary">{address}</dd>
            </div>
          )}
          {email && (
            <div className="flex gap-2">
              <dt className="shrink-0 text-ink-soft">Email</dt>
              <dd>
                <a href={`mailto:${email}`} className="text-coral-deep underline">{email}</a>
              </dd>
            </div>
          )}
          {phone && (
            <div className="flex gap-2">
              <dt className="shrink-0 text-ink-soft">Phone</dt>
              <dd>
                <a href={`tel:${phone}`} className="text-coral-deep underline">{phone}</a>
              </dd>
            </div>
          )}
        </dl>
      )}

      {(website || socials.length > 0) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {website && (
            <a
              href={website}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border-[1.5px] border-ink bg-surface-2 px-3 py-0.5 text-xs font-semibold text-ink-soft hover:text-ink"
            >
              Website
            </a>
          )}
          {socials.map((s) => (
            <a
              key={s.key}
              href={s.href}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border-[1.5px] border-ink bg-surface-2 px-3 py-0.5 text-xs font-semibold text-ink-soft hover:text-ink"
            >
              {s.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
