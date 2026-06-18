'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { ImageCarousel } from '@/components/ImageCarousel';
import { SportImage } from '@/components/SportImage';
import { useEvent } from '@/lib/api/consumer';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatDateTime, formatPaiseExact } from '@/lib/format';
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
  const [qty, setQty] = useState<Record<string, number>>({});

  const tiers = ev?.tiers ?? [];
  const lines = tiers
    .filter((t) => (qty[t.id] ?? 0) > 0)
    .map((t) => ({
      tierId: t.id,
      tierName: t.name,
      quantity: qty[t.id] ?? 0,
      unitPricePaise: t.pricePaise,
    }));
  const subtotalPaise = lines.reduce((sum, l) => sum + l.unitPricePaise * l.quantity, 0);
  const totalSelected = lines.reduce((sum, l) => sum + l.quantity, 0);

  function setTierQty(tierId: string, next: number, remaining: number | null) {
    const capped = remaining == null ? Math.max(0, next) : Math.min(Math.max(0, next), remaining);
    setQty((q) => ({ ...q, [tierId]: capped }));
  }

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

            <Card className="flex flex-col gap-4">
              {ev.description && <p className="text-sm text-text-secondary">{ev.description}</p>}

              {tiers.length === 0 ? (
                <p className="text-sm text-text-secondary">Tickets aren’t available for this event.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {tiers.map((t) => {
                    const soldOut = t.remaining != null && t.remaining <= 0;
                    const current = qty[t.id] ?? 0;
                    const atMax = t.remaining != null && current >= t.remaining;
                    return (
                      <div
                        key={t.id}
                        className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--color-border)] px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-ink">{t.name}</p>
                          {t.description && (
                            <p className="mt-0.5 text-xs text-text-secondary">{t.description}</p>
                          )}
                          <p className="mt-0.5 text-sm text-ink">
                            {t.pricePaise === 0 ? 'Free' : formatPaiseExact(t.pricePaise)}
                          </p>
                        </div>
                        {soldOut ? (
                          <span className="shrink-0 text-xs font-medium text-text-secondary">Sold out</span>
                        ) : (
                          <div className="flex shrink-0 items-center gap-2">
                            <Button
                              variant="secondary"
                              size="sm"
                              aria-label={`Decrease ${t.name}`}
                              onClick={() => setTierQty(t.id, current - 1, t.remaining)}
                              disabled={current <= 0}
                            >
                              −
                            </Button>
                            <span className="w-6 text-center text-sm font-medium text-ink">{current}</span>
                            <Button
                              variant="secondary"
                              size="sm"
                              aria-label={`Increase ${t.name}`}
                              onClick={() => setTierQty(t.id, current + 1, t.remaining)}
                              disabled={atMax}
                            >
                              +
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div className="mt-1 flex items-center justify-between border-t border-[var(--color-border)] pt-3 text-sm">
                    <span className="font-medium text-ink">Subtotal</span>
                    <span className="font-semibold text-ink">{formatPaiseExact(subtotalPaise)}</span>
                  </div>

                  <div className="pt-2">
                    <Button
                      disabled={totalSelected === 0}
                      onClick={() => {
                        const prefill: { name?: string; contact?: string } = {};
                        if (user?.displayName) prefill.name = user.displayName;
                        if (user?.phoneNumber) prefill.contact = user.phoneNumber;
                        openCheckout({ kind: 'event', eventId: ev.id, title: ev.name, lines }, prefill);
                      }}
                    >
                      {subtotalPaise === 0 ? 'Register' : `Book · ${formatPaiseExact(subtotalPaise)}`}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
