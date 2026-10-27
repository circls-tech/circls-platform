'use client';
import { useState } from 'react';
import type { MyBookingDetail, QrTicket } from '@/lib/api/types';
import { useShareTicket, useWithdrawTicketShare } from '@/lib/api/consumer';
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

/** Where one ticket stands, in a word or two. */
export function ticketHolder(t: QrTicket): string {
  if (t.share?.state === 'accepted') return `With ${t.share.acceptedBy ?? 'a friend'}`;
  if (t.share?.state === 'pending') return 'Link sent, not accepted yet';
  if (t.status === 'used') return 'Used';
  if (t.status === 'revoked') return 'Cancelled';
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

function ShareBookingModal({ booking, onClose }: { booking: MyBookingDetail; onClose: () => void }) {
  const share = useShareTicket(booking.id);
  const withdraw = useWithdrawTicketShare(booking.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The last link sent: a note when it was copied, the text itself when it
  // could be neither shared nor copied.
  const [sent, setSent] = useState<{ ticketId: string; copied: boolean; manual: string | null } | null>(null);

  async function send(t: QrTicket) {
    const note = ticketShareNote(booking, t.label);
    if (!note) return;
    setError(null);
    setBusy(t.id);
    try {
      const token = t.share?.token ?? (await share.mutateAsync(t.id)).token;
      const url = ticketLinkUrl(window.location.origin, token);
      const text = `${note.message}\n${url}`;
      const outcome = await shareLink({ title: note.title, text: note.message, url }, { copy: text });
      setSent({ ticketId: t.id, copied: outcome === 'copied', manual: outcome === 'unavailable' ? text : null });
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
                      <Button size="sm" variant="ghost" onClick={() => void takeBack(t)} disabled={busy !== null}>
                        Withdraw
                      </Button>
                    )}
                    <Button size="sm" onClick={() => void send(t)} loading={busy === t.id} disabled={busy !== null}>
                      {pending ? 'Send again' : 'Share'}
                    </Button>
                  </div>
                )}
              </div>
              {sent?.ticketId === t.id && sent.copied && (
                <p role="status" className="mt-2 text-xs text-text-secondary">
                  Link copied. Paste it into a chat with your friend.
                </p>
              )}
              {sent?.ticketId === t.id && sent.manual && <ManualCopy text={sent.manual} />}
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
