import Link from 'next/link';
import { formatPaise } from '@/lib/format';
import type { PublicMembershipWithScope } from '@/lib/api/types';

export function MembershipCard({
  membership,
  className = '',
}: {
  membership: PublicMembershipWithScope;
  className?: string;
}) {
  const href = membership.venueId ? `/venues/${membership.venueId}` : '/venues';
  return (
    <Link
      href={href}
      className={`block rounded-card border border-ink-soft bg-gradient-to-br from-ink to-ink-soft p-4 text-white transition-all hover:-translate-y-1 ${className}`}
    >
      <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-gold-500">
        {membership.scopeName}
      </p>
      <h3 className="font-display text-[19px] font-semibold">{membership.name}</h3>
      {membership.description && (
        <p className="mt-1 line-clamp-2 text-xs text-white/70">{membership.description}</p>
      )}
      <div className="mt-3 font-display text-2xl font-semibold">
        {formatPaise(membership.pricePaise)}{' '}
        <span className="font-sans text-xs text-white/70">/ {membership.durationDays} days</span>
      </div>
      <span className="mt-3 inline-block rounded-lg bg-gold-500 px-3.5 py-1.5 text-xs font-bold text-ink">
        View
      </span>
    </Link>
  );
}
