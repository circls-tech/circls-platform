'use client';
import { Suspense, use, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { BackBar } from '@/components/BackBar';
import { PreviewBanner } from '@/components/PreviewBanner';
import { StickyActionBar } from '@/components/StickyActionBar';
import { ImageCarousel } from '@/components/ImageCarousel';
import { SportImage } from '@/components/SportImage';
import { OrgBrandBlock } from '@/components/OrgBrandBlock';
import { QuestionsSection } from '@/components/questions/QuestionsSection';
import { useEvent, usePublicOrg } from '@/lib/api/consumer';
import { usePublicCoupons } from '@/lib/api/checkout';
import { useAuth } from '@/lib/firebase/auth_context';
import { countryOfAddress, currencyForCountry, formatDateTime, formatPaiseExact } from '@/lib/format';
import { useCheckoutModal, useResumeCheckout } from '@/lib/checkout/CheckoutProvider';
import { usePreviewToken } from '@/lib/preview';
import { Badge, Button, Card } from '@/lib/ui';
import { AddressLink } from '@/components/AddressLink';
import { OffersStrip } from '@/components/OffersStrip';

export default function EventPage({ params }: { params: Promise<{ id: string }> }) {
  // The preview token is read from the URL (useSearchParams), which the app
  // router only allows under a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <EventPageInner params={params} />
    </Suspense>
  );
}

function EventPageInner({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // Preview mode (lib/preview.ts): a partner or reviewer looking at an
  // unapproved event as a customer will. Same page, booking turned off.
  const preview = usePreviewToken();
  const eventQ = useEvent(id, preview);
  const { openCheckout } = useCheckoutModal();
  const { user } = useAuth();
  const ev = eventQ.data;
  // Owning-org profile for the "Organised by" block; degrades to the compact
  // brand summary while loading or when the org is unavailable.
  const orgQ = usePublicOrg(ev?.brand?.slug ?? '');
  const [qty, setQty] = useState<Record<string, number>>({});
  // Public offers for this event (partner- and Circls-funded alike); tapping
  // one carries it into checkout pre-applied.
  const offersQ = usePublicCoupons(ev ? { itemType: 'event', itemId: ev.id } : null);
  const offers = offersQ.data?.rows ?? [];
  const [offerCode, setOfferCode] = useState<string | null>(null);
  // Prices are denominated by the event's resolved location country.
  const currency = currencyForCountry(countryOfAddress(ev?.locAddressJson));

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

  // The event's per-person cap (null = no limit) applies to the TOTAL across
  // all tiers; the server enforces the same cap across past bookings too.
  const maxPerUser = ev?.maxPerUser ?? null;
  const atEventMax = maxPerUser != null && totalSelected >= maxPerUser;

  function setTierQty(tierId: string, next: number, remaining: number | null) {
    let capped = remaining == null ? Math.max(0, next) : Math.min(Math.max(0, next), remaining);
    if (maxPerUser != null) {
      // Room left under the event cap, counting what's picked in OTHER tiers.
      const others = totalSelected - (qty[tierId] ?? 0);
      capped = Math.min(capped, Math.max(0, maxPerUser - others));
    }
    setQty((q) => ({ ...q, [tierId]: capped }));
  }

  // Sign-in interrupted a purchase on this page — reopen it, and put the tier
  // quantities back on the page so closing the modal doesn't reveal an empty
  // selection behind it.
  useResumeCheckout((item, prefill) => {
    if (item.kind === 'event') {
      setQty(Object.fromEntries(item.lines.map((l) => [l.tierId, l.quantity])));
    }
    openCheckout(item, prefill);
  });

  function book() {
    if (!ev || totalSelected === 0 || preview) return;
    const prefill: { name?: string; contact?: string; couponCode?: string } = {};
    if (user?.displayName) prefill.name = user.displayName;
    if (user?.phoneNumber) prefill.contact = user.phoneNumber;
    if (offerCode) prefill.couponCode = offerCode;
    openCheckout(
      { kind: 'event', eventId: ev.id, title: ev.name, lines, currency, questions: ev.questions },
      prefill,
    );
  }

  return (
    <div className="min-h-screen">
      {preview ? <PreviewBanner noun="event" /> : <Header />}
      <main className="mx-auto max-w-3xl px-4 pt-8 pb-28">
        {!preview && <BackBar fallbackHref="/events" />}
        {eventQ.isLoading ? (
          <p className="text-sm text-text-secondary">Loading event…</p>
        ) : eventQ.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {eventQ.error instanceof Error ? eventQ.error.message : 'Failed to load event'}
          </p>
        ) : !ev ? (
          <p className="text-sm text-text-secondary">Event not found.</p>
        ) : (
          <>
            <div className="mb-6 overflow-hidden rounded-card border-[2px] border-ink shadow-offset">
              <ImageCarousel
                images={ev.images}
                alt={ev.name}
                className="h-44 sm:h-56"
                variant="hero"
                fallback={
                  <SportImage input={{ tags: ev.venueTags }} alt={ev.name} className="h-44 sm:h-56" />
                }
              />
              <div className="bg-white p-5">
                <div className="flex items-center gap-2">
                  <h1 className="font-display text-4xl font-extrabold text-ink">{ev.name}</h1>
                  {ev.isStandalone && <Badge tone="neutral" label="Event" />}
                </div>
                <p className="mt-1 text-sm text-text-secondary">{formatDateTime(ev.startsAt)}</p>
                {(ev.seriesOccurrences?.length ?? 0) > 1 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                      Pick a date · {ev.seriesOccurrences!.length} upcoming
                    </p>
                    <div className="mt-1.5 flex gap-2 overflow-x-auto pb-1">
                      {ev.seriesOccurrences!.map((occ) => {
                        const chipClass = [
                          'shrink-0 rounded-[var(--radius)] border-[2px] border-ink px-3 py-1.5 text-xs font-semibold',
                          occ.id === ev.id ? 'bg-ink text-white' : 'bg-white text-ink',
                          preview ? '' : 'hover:bg-ink/5',
                        ].join(' ');
                        const chipBody = (
                          <>
                            {formatDateTime(occ.startsAt)}
                            {occ.locationName !== ev.locationName && (
                              <span className="block text-[10px] font-normal opacity-75">
                                {occ.locationName}
                              </span>
                            )}
                          </>
                        );
                        // A preview token opens this one date only, so the
                        // other chips show where the dates will sit but don't
                        // navigate — they would land on a 404.
                        return preview ? (
                          <span
                            key={occ.id}
                            aria-current={occ.id === ev.id ? 'date' : undefined}
                            className={chipClass}
                          >
                            {chipBody}
                          </span>
                        ) : (
                          <Link
                            key={occ.id}
                            href={`/events/${occ.id}`}
                            aria-current={occ.id === ev.id ? 'date' : undefined}
                            className={chipClass}
                          >
                            {chipBody}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}
                <p className="mt-2 text-sm font-medium text-ink">{ev.locationName}</p>
                <AddressLink addressJson={ev.locAddressJson} lat={ev.locLat} lng={ev.locLng} className="mt-2" />
                {!ev.isStandalone && ev.venueId && (
                  <Link href={`/venues/${ev.venueId}`} className="mt-1 block text-sm font-semibold text-coral-deep underline">
                    More at {ev.venueName}
                  </Link>
                )}
              </div>
            </div>

            <Card className="flex flex-col gap-4">
              {ev.description && <p className="whitespace-pre-line text-sm text-text-secondary">{ev.description}</p>}

              {tiers.length === 0 ? (
                <p className="text-sm text-text-secondary">Tickets aren’t available for this event.</p>
              ) : (
                <div className="mt-2 flex flex-col gap-2.5">
                  {maxPerUser != null && (
                    <p className="text-xs font-medium text-text-secondary">
                      Limited to {maxPerUser} ticket{maxPerUser > 1 ? 's' : ''} per person for this event.
                    </p>
                  )}
                  {tiers.map((t) => {
                    const soldOut = t.remaining != null && t.remaining <= 0;
                    const current = qty[t.id] ?? 0;
                    const atMax = (t.remaining != null && current >= t.remaining) || atEventMax;
                    return (
                      <div
                        key={t.id}
                        className={[
                          'flex items-center justify-between gap-3 rounded-xl border-[1.5px] border-ink px-3.5 py-2.5 transition-colors',
                          current > 0 ? 'bg-pastel-butter/60' : 'bg-surface',
                        ].join(' ')}
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-x-2.5">
                            <p className="text-sm font-bold text-ink">{t.name}</p>
                            <p className="font-display text-sm font-extrabold text-coral-deep">
                              {t.pricePaise === 0 ? 'Free' : formatPaiseExact(t.pricePaise, currency)}
                            </p>
                          </div>
                          {t.description && (
                            <p className="mt-0.5 text-xs text-text-secondary">{t.description}</p>
                          )}
                        </div>
                        {soldOut ? (
                          <span className="shrink-0 text-xs font-medium text-text-secondary">Sold out</span>
                        ) : (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              aria-label={`Decrease ${t.name}`}
                              onClick={() => setTierQty(t.id, current - 1, t.remaining)}
                              disabled={current <= 0}
                              className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-ink bg-white text-sm font-bold leading-none text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              −
                            </button>
                            <span className="w-7 text-center font-display text-sm font-extrabold text-ink">
                              {current}
                            </span>
                            <button
                              type="button"
                              aria-label={`Increase ${t.name}`}
                              onClick={() => setTierQty(t.id, current + 1, t.remaining)}
                              disabled={atMax}
                              className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-ink bg-white text-sm font-bold leading-none text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              +
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div className="mt-1 flex items-center justify-between border-t-[1.5px] border-dashed border-ink/25 pt-3 text-sm">
                    <span className="font-medium text-ink">Subtotal</span>
                    <span className="font-display font-extrabold text-ink">{formatPaiseExact(subtotalPaise, currency)}</span>
                  </div>
                  <p className="text-xs text-text-secondary">
                    {totalSelected === 0
                      ? 'Pick your tickets to continue.'
                      : `Review and confirm in the bar below.`}
                  </p>
                </div>
              )}
            </Card>

            <OffersStrip
              offers={offers}
              currency={currency}
              selected={offerCode}
              onSelect={setOfferCode}
              heading="Offers for this event"
            />

            {ev.brand && (
              <section className="mt-6">
                <Card>
                  <OrgBrandBlock brand={ev.brand} org={orgQ.data} variant="byline" label="Organised by" />
                </Card>
              </section>
            )}

            {/* Q&A with the organiser (#106 questions threads). Not in a
                preview: there is nothing to ask about yet, and the section's
                reads are for public listings. */}
            <section className="mt-8">
              {preview ? (
                <Card>
                  <h2 className="font-display text-xl font-extrabold text-ink">Questions</h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    Customers can ask you questions here once the event is live.
                  </p>
                </Card>
              ) : (
                <QuestionsSection subjectType="event" subjectId={ev.id} subjectName={ev.name} />
              )}
            </section>
          </>
        )}
      </main>

      {ev && totalSelected > 0 && (
        <StickyActionBar
          maxWidthClass="max-w-3xl"
          summary={
            <>
              <span className="font-display font-extrabold text-ink">
                {totalSelected} ticket{totalSelected > 1 ? 's' : ''}
              </span>
              <span className="text-text-secondary"> · {formatPaiseExact(subtotalPaise, currency)}</span>
            </>
          }
          action={
            <Button
              onClick={book}
              disabled={Boolean(preview)}
              title={preview ? 'Booking is turned off in preview' : undefined}
            >
              {subtotalPaise === 0 ? 'Register' : `Book · ${formatPaiseExact(subtotalPaise, currency)}`}
            </Button>
          }
        />
      )}
    </div>
  );
}
