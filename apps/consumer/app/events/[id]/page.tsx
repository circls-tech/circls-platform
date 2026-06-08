'use client';
import { use } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { ImageCarousel } from '@/components/ImageCarousel';
import { SportImage } from '@/components/SportImage';
import { useEvent } from '@/lib/api/consumer';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatDateTime, formatPaise } from '@/lib/format';
import { useCheckoutModal } from '@/lib/checkout/CheckoutProvider';
import { Badge, Button, Card } from '@/lib/ui';

function AddressLine({ addressJson }: { addressJson: Record<string, unknown> | null }) {
  if (!addressJson) return null;
  const parts = ['line1', 'line2', 'city', 'state', 'pincode']
    .map((k) => addressJson[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (parts.length === 0) return null;
  return <p className="mt-2 text-sm text-text-secondary">{parts.join(', ')}</p>;
}

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const eventQ = useEvent(id);
  const { openCheckout } = useCheckoutModal();
  const { user } = useAuth();
  const ev = eventQ.data;
  const isFree = (ev?.pricePaise ?? 0) === 0;
  const mapsHref =
    ev && ev.locLat != null && ev.locLng != null
      ? `https://www.google.com/maps/search/?api=1&query=${ev.locLat},${ev.locLng}`
      : null;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8">
        {eventQ.isLoading ? (
          <p className="text-sm text-text-secondary">Loading event…</p>
        ) : eventQ.isError ? (
          <p className="text-sm text-red-600">
            {eventQ.error instanceof Error ? eventQ.error.message : 'Failed to load event'}
          </p>
        ) : !ev ? (
          <p className="text-sm text-text-secondary">Event not found.</p>
        ) : (
          <>
            <div className="mb-6 overflow-hidden rounded-card border border-border">
              <ImageCarousel
                images={ev.images}
                alt={ev.name}
                className="h-44 sm:h-56"
                fallback={
                  <SportImage input={{ tags: ev.venueTags }} alt={ev.name} className="h-44 sm:h-56" />
                }
              />
              <div className="bg-white p-5">
                <div className="flex items-center gap-2">
                  <h1 className="font-display text-3xl font-semibold text-ink">{ev.name}</h1>
                  {ev.isStandalone && <Badge tone="neutral" label="Event" />}
                </div>
                <p className="mt-1 text-sm text-text-secondary">{formatDateTime(ev.startsAt)}</p>
                <p className="mt-2 text-sm font-medium text-ink">{ev.locationName}</p>
                <AddressLine addressJson={ev.locAddressJson} />
                {mapsHref && (
                  <a href={mapsHref} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm text-gold-600 underline">
                    View on map
                  </a>
                )}
                {!ev.isStandalone && ev.venueId && (
                  <Link href={`/venues/${ev.venueId}`} className="mt-1 block text-sm text-gold-600 underline">
                    More at {ev.venueName}
                  </Link>
                )}
              </div>
            </div>

            <Card className="flex flex-col gap-3">
              {ev.description && <p className="text-sm text-text-secondary">{ev.description}</p>}
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <span className="font-medium text-ink">{formatPaise(ev.pricePaise)}</span>
                {ev.capacity != null && <span>· {ev.capacity} seats</span>}
              </div>
              <div className="pt-2">
                <Button
                  onClick={() => {
                    const prefill: { name?: string; contact?: string } = {};
                    if (user?.displayName) prefill.name = user.displayName;
                    if (user?.phoneNumber) prefill.contact = user.phoneNumber;
                    openCheckout({ kind: 'event', eventId: ev.id, title: ev.name }, prefill);
                  }}
                >
                  {isFree ? 'Register' : 'Book'}
                </Button>
              </div>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
