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
  const href = `/memberships/${membership.id}`;
  return (
    <Link
      href={href}
      className={`block rounded-card border-[2.5px] border-ink bg-lav p-4 text-ink shadow-offset-sm transition-[transform,box-shadow] duration-150 hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset ${className}`}
    >
      <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ink-soft">
        {membership.scopeName}
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
    </Link>
  );
}
