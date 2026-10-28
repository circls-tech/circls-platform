'use client';
import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { useClaimTicketShare, useTicketSharePreview } from '@/lib/api/consumer';
import type { TicketSharePreview } from '@/lib/api/types';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatDayAtTime } from '@/lib/format';
import { Button, Card } from '@/lib/ui';

/** Why a link can't be added, in the words the person opening it needs. */
function blockedMessage(s: TicketSharePreview): string | null {
  const who = s.sharedBy ?? 'Your friend';
  switch (s.state) {
    case 'own':
      return 'This is your own ticket. Send the link to a friend instead.';
    case 'taken':
      return `Someone else has already added this ticket. Ask ${who} for another link.`;
    case 'withdrawn':
      return `${who} took this link back. Ask them for a new one.`;
    case 'inactive':
      return 'This booking is no longer active: it was cancelled, it’s over, or the ticket was already used.';
    default:
      return null;
  }
}

/**
 * A ticket a friend shared ("Share booking"): what it is, and "Add to my
 * bookings", after which the booking is in your My Bookings with that ticket's
 * QR to show at the venue. Signing in comes first, since the ticket is added
 * to an account.
 */
export default function SharedTicketPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { user, loading } = useAuth();
  const router = useRouter();
  const previewQ = useTicketSharePreview(token);
  const claim = useClaimTicketShare(token);
  const [claimError, setClaimError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?redirect=${encodeURIComponent(`/tickets/${token}`)}`);
  }, [loading, user, router, token]);

  async function add() {
    setClaimError(null);
    try {
      const { bookingId } = await claim.mutateAsync();
      router.push(`/me/bookings/${bookingId}`);
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : 'Could not add this ticket. Please try again.');
      void previewQ.refetch();
    }
  }

  const s = previewQ.data;
  const blocked = s ? blockedMessage(s) : null;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-xl px-4 py-10">
        {loading || !user || previewQ.isLoading ? (
          <p className="text-sm text-text-secondary">Loading…</p>
        ) : previewQ.isError || !s ? (
          <Card>
            <h1 className="font-display text-2xl font-extrabold text-ink">This link isn’t valid</h1>
            <p className="mt-2 text-sm text-text-secondary">Check you have the whole link, or ask your friend to send it again.</p>
          </Card>
        ) : (
          <Card>
            <p className="text-xs font-bold uppercase tracking-widest text-coral-deep">
              {s.state === 'own'
                ? 'A ticket you shared'
                : s.sharedBy
                  ? `${s.sharedBy} shared a ticket with you`
                  : 'A ticket for you'}
            </p>
            <h1 className="mt-2 font-display text-3xl font-extrabold text-ink">{s.title}</h1>
            <div className="mt-3 flex flex-col gap-1 text-sm text-ink">
              {s.startsAt && <p>📅 {formatDayAtTime(s.startsAt, s.timeZone)}</p>}
              {s.place && <p>📍 {s.place}</p>}
              {s.ticketLabel && <p>🎟️ {s.ticketLabel}</p>}
            </div>

            {s.state === 'available' && (
              <>
                <p className="mt-5 text-sm text-text-secondary">
                  Add it to your bookings to get your own QR ticket to show at the venue.
                </p>
                <Button onClick={() => void add()} loading={claim.isPending} className="mt-4 w-full">
                  Add to my bookings
                </Button>
              </>
            )}
            {s.state === 'yours' && s.bookingId && (
              <>
                <p className="mt-5 text-sm text-text-secondary">It’s already in your bookings.</p>
                <Link href={`/me/bookings/${s.bookingId}`} className="mt-4 inline-block text-sm font-semibold text-coral-deep underline">
                  View your ticket
                </Link>
              </>
            )}
            {blocked && <p className="mt-5 text-sm font-semibold text-ink">{blocked}</p>}
            {s.state === 'own' && s.bookingId && (
              <Link href={`/me/bookings/${s.bookingId}`} className="mt-3 inline-block text-sm font-semibold text-coral-deep underline">
                Back to your booking
              </Link>
            )}
            {claimError && (
              <p role="alert" className="mt-3 text-sm font-semibold text-petal-red">
                {claimError}
              </p>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}
