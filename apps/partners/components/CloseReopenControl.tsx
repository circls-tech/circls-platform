'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useCloseImpact } from '@/lib/api/queries';
import type { ListingStatus } from '@/lib/api/types';
import { Button, Modal } from '@/lib/ui';

/** Where reopening will take a venue or arena, in the partner's words. */
function reopenOutcome(statusBeforeClose: ListingStatus | null | undefined): string {
  switch (statusBeforeClose) {
    case 'active':
      return 'It goes live again straight away.';
    case 'rejected':
      return "It comes back as rejected — reopening doesn't overturn Circls review.";
    default:
      // pending_review, or closed before its prior state was recorded.
      return 'It goes back to Circls review before customers can see it again.';
  }
}

export interface CloseReopenControlProps {
  noun: 'venue' | 'arena';
  target: { name: string; status: ListingStatus; statusBeforeClose?: ListingStatus | null };
  /** The venue whose bookings are counted; with `arenaId`, only that arena's
   *  court bookings (events belong to the venue, not an arena). */
  venueId: string;
  arenaId?: string;
  tenantId: string;
  setOpen: { mutateAsync: (action: 'close' | 'reopen') => Promise<unknown>; isPending: boolean };
}

/**
 * Close a venue or an arena, or reopen a closed one.
 *
 * Closing takes it off sale — the whole venue from the consumer portal, or
 * one arena while the rest of its venue stays open — and deletes and cancels
 * nothing. Both directions ask first: closing hides a live listing, and
 * reopening may not go where the partner expects, so each spells out exactly
 * what happens.
 */
export function CloseReopenControl({
  noun,
  target,
  venueId,
  arenaId,
  tenantId,
  setOpen,
}: CloseReopenControlProps) {
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const closed = target.status === 'suspended';

  // Only asked for while the close dialog is up. Event registrations are
  // counted too: the bookings list can't see them (they have no slots), yet
  // closing a venue takes its events off the consumer portal.
  const impact = useCloseImpact(venueId, arenaId, !closed && confirming);
  const courts = impact.data?.upcomingSlotBookings ?? 0;
  const events = impact.data?.upcomingEvents ?? 0;
  const registrations = impact.data?.upcomingEventRegistrations ?? 0;

  function open() {
    setErr(null);
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

  const bookingsHref = `/venues/${venueId}/bookings${tenantId ? `?tenantId=${tenantId}` : ''}`;

  return (
    <>
      {closed ? (
        <Button petal="#BCE3A0" size="sm" onClick={open}>
          Reopen {noun}
        </Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={open}>
          Close {noun}
        </Button>
      )}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={closed ? `Reopen ${target.name}?` : `Close ${target.name}?`}
        maxWidth="max-w-md"
      >
        <div className="flex flex-col gap-3 text-sm text-slate-600">
          {closed ? (
            <p>{reopenOutcome(target.statusBeforeClose)}</p>
          ) : (
            <>
              <p>
                {noun === 'venue'
                  ? "Customers won't find this venue or be able to book it online while it's closed."
                  : "Customers won't be able to book this arena online while it's closed. The rest of the venue stays open."}{' '}
                Nothing is deleted, and you can reopen it at any time.
              </p>
              {impact.isLoading ? (
                <p className="text-slate-400">Checking upcoming bookings…</p>
              ) : impact.isError ? (
                <p className="text-slate-500">
                  Couldn&apos;t check upcoming bookings. Check{' '}
                  <Link href={bookingsHref} className="font-medium underline">
                    View bookings
                  </Link>{' '}
                  before closing.
                </p>
              ) : courts === 0 && events === 0 ? (
                <p>
                  There are no upcoming bookings{noun === 'venue' ? ' or events' : ''}.
                </p>
              ) : (
                <>
                  {courts > 0 && (
                    <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                      <span className="font-semibold">
                        {courts} upcoming court booking{courts === 1 ? '' : 's'}
                      </span>{' '}
                      {courts === 1 ? 'stays' : 'stay'} booked — closing doesn&apos;t cancel
                      anything. Contact or cancel those customers from{' '}
                      <Link href={bookingsHref} className="font-medium underline">
                        View bookings
                      </Link>
                      .
                    </p>
                  )}
                  {events > 0 && (
                    <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                      <span className="font-semibold">
                        {events} upcoming event{events === 1 ? '' : 's'}
                      </span>{' '}
                      {registrations > 0 && (
                        <>
                          with{' '}
                          <span className="font-semibold">
                            {registrations} registration{registrations === 1 ? '' : 's'}
                          </span>{' '}
                        </>
                      )}
                      will come off the consumer portal while the venue is closed. Existing
                      registrations stay valid, but no one new can register.
                    </p>
                  )}
                </>
              )}
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
              {closed ? `Reopen ${noun}` : `Close ${noun}`}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
