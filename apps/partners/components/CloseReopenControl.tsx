'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useSetVenueOpen, useVenueBookings } from '@/lib/api/queries';
import type { Venue } from '@/lib/api/types';
import { Button, Modal } from '@/lib/ui';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Where reopening will take this venue, in the partner's words. */
function reopenOutcome(v: Venue): string {
  switch (v.statusBeforeClose) {
    case 'active':
      return 'It goes live again straight away.';
    case 'rejected':
      return "It comes back as rejected — reopening doesn't overturn Circls review.";
    default:
      // pending_review, or a venue closed before its prior state was recorded.
      return 'It goes back to Circls review before customers can see it again.';
  }
}

/**
 * Close a venue, or reopen a closed one.
 *
 * Closing takes the venue off the consumer portal and stops new online
 * bookings; it deletes nothing and cancels nothing. Both directions ask first:
 * closing hides a live listing, and reopening may not go where the partner
 * expects, so each spells out exactly what happens.
 */
export function VenueOpenControl({ venue, tenantId }: { venue: Venue; tenantId: string }) {
  const setOpen = useSetVenueOpen(venue.id);
  const [confirming, setConfirming] = useState(false);
  // Fixed when the dialog opens, so the bookings query key doesn't change on
  // every render and refetch in a loop.
  const [windowStart, setWindowStart] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const closed = venue.status === 'suspended';

  // Only asked for while the close dialog is up; an empty id disables it.
  const upcoming = useVenueBookings(!closed && confirming ? venue.id : '', {
    from: windowStart ?? new Date(0).toISOString(),
    to: new Date((windowStart ? Date.parse(windowStart) : 0) + YEAR_MS).toISOString(),
    status: 'confirmed',
  });
  const upcomingCount = upcoming.data?.length ?? null;

  function open() {
    setErr(null);
    setWindowStart(new Date().toISOString());
    setConfirming(true);
  }

  async function confirm() {
    setErr(null);
    try {
      await setOpen.mutateAsync(closed ? 'reopen' : 'close');
      setConfirming(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const bookingsHref = `/venues/${venue.id}/bookings${tenantId ? `?tenantId=${tenantId}` : ''}`;

  return (
    <>
      {closed ? (
        <Button petal="#BCE3A0" size="sm" onClick={open}>
          Reopen venue
        </Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={open}>
          Close venue
        </Button>
      )}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={closed ? `Reopen ${venue.name}?` : `Close ${venue.name}?`}
        maxWidth="max-w-md"
      >
        <div className="flex flex-col gap-3 text-sm text-slate-600">
          {closed ? (
            <p>{reopenOutcome(venue)}</p>
          ) : (
            <>
              <p>
                Customers won&apos;t find this venue or be able to book it online while it&apos;s
                closed. Nothing is deleted, and you can reopen it at any time.
              </p>
              {upcoming.isLoading ? (
                <p className="text-slate-400">Checking upcoming bookings…</p>
              ) : upcomingCount === 0 ? (
                <p>There are no upcoming bookings.</p>
              ) : upcomingCount !== null ? (
                <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                  <span className="font-semibold">
                    {upcomingCount} upcoming booking{upcomingCount === 1 ? '' : 's'}
                  </span>{' '}
                  {upcomingCount === 1 ? 'stays' : 'stay'} booked — closing doesn&apos;t cancel
                  anything. Contact or cancel those customers from{' '}
                  <Link href={bookingsHref} className="font-medium underline">
                    View bookings
                  </Link>
                  .
                </p>
              ) : null}
            </>
          )}

          {err && <p className="text-red-600">{err}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep it {closed ? 'closed' : 'open'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={closed ? 'primary' : 'danger'}
              loading={setOpen.isPending}
              onClick={() => void confirm()}
            >
              {closed ? 'Reopen venue' : 'Close venue'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
