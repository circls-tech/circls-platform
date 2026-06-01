'use client';
import { use, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { useMyBooking } from '@/lib/api/consumer';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatDate, formatDateTime, formatPaise, formatTime } from '@/lib/format';
import { Card, StatusPill } from '@/lib/ui';

const ITEM_TYPE_LABELS: Record<string, string> = {
  slot: 'Court booking',
  event: 'Event',
  membership: 'Membership',
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  razorpay_route: 'Paid online',
  external: 'Paid at venue',
  free: 'Free',
};

/** A label/value row in the details list. */
function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right font-medium text-ink">{value}</span>
    </div>
  );
}

export default function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading } = useAuth();
  const router = useRouter();
  const bookingQ = useMyBooking(id);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?redirect=/me/bookings/${id}`);
  }, [loading, user, router, id]);

  const b = bookingQ.data;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <Link href="/me/bookings" className="text-sm text-gold-600 underline">
          ← All bookings
        </Link>

        {loading || !user ? (
          <p className="mt-6 text-sm text-text-secondary">Loading…</p>
        ) : bookingQ.isLoading ? (
          <p className="mt-6 text-sm text-text-secondary">Loading booking…</p>
        ) : bookingQ.isError ? (
          <p className="mt-6 text-sm text-red-600">
            {bookingQ.error instanceof Error ? bookingQ.error.message : 'Failed to load booking'}
          </p>
        ) : !b ? (
          <p className="mt-6 text-sm text-text-secondary">Booking not found.</p>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            {/* Header: title, type, status, total */}
            <Card>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h1 className="font-display text-2xl font-semibold text-ink">
                    {b.event?.name ?? b.membership?.name ?? b.venueName}
                  </h1>
                  <p className="mt-0.5 text-sm text-text-secondary">
                    {ITEM_TYPE_LABELS[b.itemType] ?? b.itemType}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <StatusPill status={b.status} />
                  <span className="text-lg font-semibold text-ink">{formatPaise(b.totalPaise)}</span>
                </div>
              </div>
            </Card>

            {/* Court (slot) booking: list each booked slot */}
            {b.itemType === 'slot' && b.slots.length > 0 && (
              <Card title="Your slots">
                <div className="flex flex-col divide-y divide-border">
                  {b.slots.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                      <div>
                        <p className="text-sm font-medium text-ink">{s.arenaName}</p>
                        <p className="mt-0.5 text-sm text-text-secondary">
                          {formatDate(s.startAt)} · {formatTime(s.startAt)} – {formatTime(s.endAt)}
                        </p>
                      </div>
                      <span className="text-sm font-medium text-ink">{formatPaise(s.pricePaise)}</span>
                    </div>
                  ))}
                </div>
                {b.venueId && (
                  <Link href={`/venues/${b.venueId}`} className="mt-4 inline-block text-sm text-gold-600 underline">
                    View {b.venueName}
                  </Link>
                )}
              </Card>
            )}

            {/* Event booking */}
            {b.itemType === 'event' && b.event && (
              <Card title="Event details">
                <p className="text-sm font-medium text-ink">{b.event.name}</p>
                <p className="mt-0.5 text-sm text-text-secondary">
                  {formatDateTime(b.event.startsAt)} – {formatTime(b.event.endsAt)}
                </p>
                {b.event.description && (
                  <p className="mt-3 text-sm text-text-secondary">{b.event.description}</p>
                )}
                <Link href={`/events/${b.event.id}`} className="mt-4 inline-block text-sm text-gold-600 underline">
                  View event
                </Link>
              </Card>
            )}

            {/* Membership purchase */}
            {b.itemType === 'membership' && b.membership && (
              <Card title="Membership">
                <p className="text-sm font-medium text-ink">{b.membership.name}</p>
                <p className="mt-0.5 text-sm text-text-secondary">
                  Valid for {b.membership.durationDays} days
                </p>
                {b.membership.description && (
                  <p className="mt-3 text-sm text-text-secondary">{b.membership.description}</p>
                )}
              </Card>
            )}

            {/* Booking metadata */}
            <Card title="Booking details">
              <div className="flex flex-col divide-y divide-border">
                <DetailRow label="Booked on" value={formatDateTime(b.createdAt)} />
                <DetailRow label="Payment" value={PAYMENT_METHOD_LABELS[b.paymentMethod] ?? b.paymentMethod} />
                {b.customerName && <DetailRow label="Name" value={b.customerName} />}
                {b.customerContact && <DetailRow label="Contact" value={b.customerContact} />}
                {b.note && <DetailRow label="Note" value={b.note} />}
                <DetailRow label="Reference" value={<span className="font-mono text-xs">{b.id}</span>} />
              </div>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
