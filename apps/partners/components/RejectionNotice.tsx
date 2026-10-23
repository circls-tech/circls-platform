'use client';

import type { ListingRejection } from '@/lib/api/types';

/**
 * What Circls asked to change on a rejected listing, and how to send it back.
 *
 * A rejection is not a dead end: the listing stays editable, off the customer
 * site, until it is submitted again — so the notice says what to fix and, for
 * those who can, what to press afterwards.
 */
export function RejectionNotice({
  rejection,
  noun,
  canWrite,
}: {
  /** From the detail read; null/undefined when Circls gave no record of why. */
  rejection: ListingRejection | null | undefined;
  /** "event", "venue", "arena", "plan". */
  noun: string;
  /** Owners and Managers fix and resubmit; everyone else is told who can. */
  canWrite: boolean;
}) {
  const when = rejection
    ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(
        new Date(rejection.rejectedAt),
      )
    : null;
  return (
    <div
      role="status"
      className="flex flex-col gap-1 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <p className="font-semibold">
        Circls asked for changes{when ? ` on ${when}` : ''}
      </p>
      <p className="whitespace-pre-line">
        {rejection?.reason ?? 'No reason was given — contact Circls support if it isn’t clear what to change.'}
      </p>
      <p className="text-xs text-amber-800">
        {canWrite
          ? `This ${noun} stays off the customer site. Edit it, then press Submit again to send it back for review.`
          : `This ${noun} stays off the customer site until an Owner or Manager fixes it and submits it again.`}
      </p>
    </div>
  );
}
