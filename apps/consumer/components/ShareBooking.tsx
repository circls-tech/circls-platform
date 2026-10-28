'use client';
import { useEffect, useState } from 'react';
import type { MyBookingDetail, QrTicket } from '@/lib/api/types';
import { useMyBooking, useShareTicket, useWithdrawTicketShare } from '@/lib/api/consumer';
import { ticketShareNote } from '@/lib/booking_invite';
import { shareLink, ticketLinkUrl } from '@/lib/share';
import { Button, Modal } from '@/lib/ui';
import { ManualCopy } from '@/components/InviteButton';

/** A ticket stub: the mark on "Share booking". */
function TicketIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z" />
      <path d="M14 6v12" strokeDasharray="2 2.5" />
    </svg>
  );
}

/** Where one ticket stands, in a word or two: a cancelled or used ticket says so before who has it. */
export function ticketHolder(t: QrTicket): string {
  if (t.status === 'revoked') return 'Cancelled';
  const friend = t.share?.state === 'accepted' ? (t.share.acceptedBy ?? 'a friend') : null;
  if (t.status === 'used') return friend ? `Used by ${friend}` : 'Used';
  if (friend) return `With ${friend}`;
  if (t.share?.state === 'pending') return 'Link sent, not accepted yet';
  return 'With you';
}

/**
 * "Share booking": hand tickets of your event or court booking to friends,
 * BookMyShow-style. Each ticket gets its own link; the friend who opens it and
 * adds it sees the booking in their My Bookings with that ticket's QR, and can
 * show it at the venue themselves. You keep every ticket in your own view, and
 * stay the only one who can cancel. Once a friend has added a ticket it stays
 * theirs; a link nobody has added yet can be withdrawn.
 *
 * The link goes out through the device's share sheet with a short note (see
 * `ticketShareNote`), or is copied where there is no sheet. A link already out
 * is sent again as it is rather than replaced.
 */
export function ShareBookingButton({ booking, className = '' }: { booking: MyBookingDetail; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} className={`w-full sm:w-auto ${className}`}>
        <TicketIcon className="h-4 w-4" />
        <span>Share booking</span>
      </Button>
      {open && <ShareBookingModal booking={booking} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Whether the tap that started this is still live (Safari's share sheet and clipboard need one); unknown counts as yes. */
function tapStillLive(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return activation ? activation.isActive : true;
}

function ShareBookingModal({ booking, onClose }: { booking: MyBookingDetail; onClose: () => void }) {
  const share = useShareTicket(booking.id);
  const withdraw = useWithdrawTicketShare(booking.id);
  // The links shown were loaded with the page; one may have been withdrawn or
  // accepted since (in the app, say). Load them again, and send nothing until
  // they're in.
  const { refetch, isFetching } = useMyBooking(booking.id);
  useEffect(() => {
    void refetch();
  }, [refetch]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What came of the last link sent: copied, the text itself when it could be
  // neither shared nor copied, or ready when making it took longer than the
  // tap lasts (the next tap shares it).
  const [sent, setSent] = useState<{ ticketId: string; outcome: 'copied' | 'manual' | 'ready'; text: string } | null>(
    null,
  );

  async function send(t: QrTicket) {
    const note = ticketShareNote(booking, t.label);
    if (!note) return;
    setError(null);
    setBusy(t.id);
    try {
      // A link that's out is shared straight away, so the sheet opens on the
      // tap; a new one is made first.
      const cached = t.share?.state === 'pending' ? t.share.token : null;
      const token = cached ?? (await share.mutateAsync(t.id)).token;
      const url = ticketLinkUrl(window.location.origin, token);
      const text = `${note.message}\n${url}`;
      if (!cached && !tapStillLive()) {
        setSent({ ticketId: t.id, outcome: 'ready', text });
        return;
      }
      const outcome = await shareLink({ title: note.title, text: note.message, url }, { copy: text });
      setSent(
        outcome === 'copied' || outcome === 'unavailable'
          ? { ticketId: t.id, outcome: outcome === 'copied' ? 'copied' : 'manual', text }
          : null,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not share this ticket. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function takeBack(t: QrTicket) {
    setError(null);
    setBusy(t.id);
    try {
      await withdraw.mutateAsync(t.id);
      if (sent?.ticketId === t.id) setSent(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not withdraw this link. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open onClose={onClose} title="Share booking">
      <p className="text-sm text-text-secondary">
        Give a ticket to a friend: they get a link, add it to their bookings, and show their own QR at the venue.
        Once they’ve added it, it’s theirs.
      </p>
      <ul className="mt-4 flex flex-col divide-y divide-ink/15">
        {booking.qrTickets.map((t, i) => {
          const idle = busy === null && !isFetching;
          const canSend = t.status === 'active' && t.share?.state !== 'accepted';
          const pending = t.share?.state === 'pending';
          return (
            <li key={t.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{t.label ?? `Ticket ${i + 1}`}</p>
                  <p className="text-xs text-text-secondary">{ticketHolder(t)}</p>
                </div>
                {canSend && (
                  <div className="flex gap-2">
                    {pending && (
                      <Button size="sm" variant="ghost" onClick={() => void takeBack(t)} disabled={!idle}>
                        Withdraw
                      </Button>
                    )}
                    <Button size="sm" onClick={() => void send(t)} loading={busy === t.id} disabled={!idle}>
                      {pending ? 'Send again' : 'Share'}
                    </Button>
                  </div>
                )}
              </div>
              {sent?.ticketId === t.id && sent.outcome !== 'manual' && (
                <p role="status" className="mt-2 text-xs text-text-secondary">
                  {sent.outcome === 'copied'
                    ? 'Link copied. Paste it into a chat with your friend.'
                    : 'Link ready. Tap Send again to share it.'}
                </p>
              )}
              {sent?.ticketId === t.id && sent.outcome === 'manual' && <ManualCopy text={sent.text} />}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-sm font-semibold text-petal-red">
          {error}
        </p>
      )}
      <Button variant="secondary" onClick={onClose} className="mt-5 w-full">
        Done
      </Button>
    </Modal>
  );
}
