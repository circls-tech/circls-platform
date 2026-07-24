'use client';
import { use, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { BackBar } from '@/components/BackBar';
import { StickyActionBar } from '@/components/StickyActionBar';
import { OrgBrandBlock } from '@/components/OrgBrandBlock';
import { QuestionsSection } from '@/components/questions/QuestionsSection';
import { useMembership, usePublicOrg } from '@/lib/api/consumer';
import { useAuth } from '@/lib/firebase/auth_context';
import { currencyForCountry, formatPaise } from '@/lib/format';
import { membershipScope } from '@/lib/trust';
import { useCheckoutModal } from '@/lib/checkout/CheckoutProvider';
import type { MembershipBenefits, PublicMembershipTier } from '@/lib/api/types';
import { Badge, Button, Card } from '@/lib/ui';

/** Render the typed benefits list (PR #110) as a "What's included" list: each
 *  item has a label and an optional detail line. Nothing renders when empty. */
function Benefits({ benefits }: { benefits: MembershipBenefits }) {
  const items = benefits?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div>
      <h2 className="font-display text-lg font-extrabold text-ink">What&apos;s included</h2>
      <ul className="mt-2 space-y-1.5 text-sm text-text-secondary">
        {items.map((b, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className="select-none font-bold text-coral-deep">✓</span>
            <span>
              <span className="font-medium text-text-primary">{b.label}</span>
              {b.detail && <span className="text-text-secondary"> — {b.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function MembershipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const membershipQ = useMembership(id);
  const { openCheckout } = useCheckoutModal();
  const { user } = useAuth();
  const m = membershipQ.data;
  // Enrich with the full org profile when we know the brand slug. Degrades to
  // the compact brand summary (name + logo) if this 404s or is still loading.
  const orgQ = usePublicOrg(m?.brand?.slug ?? '');

  const scope = m ? membershipScope(m) : null;
  // Prices are denominated by the plan's venue/tenant country.
  const currency = currencyForCountry(m?.country);

  // Explicit selection only — the sticky Buy bar appears once a tier is tapped,
  // matching the event (tickets) and venue (slot cart) flows.
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const tiers = m?.tiers ?? [];
  const multiTier = tiers.length > 1;
  const selectedTier: PublicMembershipTier | undefined = tiers.find(
    (t) => t.id === selectedTierId,
  );

  function buy(tier: PublicMembershipTier | undefined) {
    if (!m) return;
    const prefill: { name?: string; contact?: string } = {};
    if (user?.displayName) prefill.name = user.displayName;
    if (user?.phoneNumber) prefill.contact = user.phoneNumber;
    openCheckout(
      {
        kind: 'membership',
        membershipId: m.id,
        title: tier ? `${m.name} — ${tier.name}` : m.name,
        currency,
        ...(tier ? { membershipTierId: tier.id } : {}),
      },
      prefill,
    );
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className={`mx-auto max-w-3xl px-4 pt-16${selectedTier ? ' pb-28' : ' pb-8'}`}>
        <BackBar />
        {membershipQ.isLoading ? (
          <p className="text-sm text-text-secondary">Loading membership…</p>
        ) : membershipQ.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {membershipQ.error instanceof Error ? membershipQ.error.message : 'Failed to load membership'}
          </p>
        ) : !m || !scope ? (
          <p className="text-sm text-text-secondary">Membership not found.</p>
        ) : (
          <>
            <div className="mb-6 overflow-hidden rounded-card border-[2.5px] border-ink shadow-offset">
              {m.artworkUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={m.artworkUrl}
                  alt={m.name}
                  className="h-44 w-full border-b-[2.5px] border-ink object-cover sm:h-56"
                />
              ) : null}
              <div className="bg-lav p-6 text-ink">
                <div className="flex items-center gap-2">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-ink-soft">{scope.label}</p>
                  {scope.brandWide && <Badge tone="neutral" label="Brand-wide" />}
                </div>
                <h1 className="mt-1 font-display text-4xl font-extrabold">{m.name}</h1>
                {m.description && <p className="mt-2 text-sm text-ink-soft">{m.description}</p>}
                <div className="mt-4 font-display text-2xl font-extrabold">
                  {multiTier && <span className="font-sans text-xs font-medium text-ink-soft">from </span>}
                  {formatPaise(m.pricePaise, currency)}{' '}
                  <span className="font-sans text-xs font-medium text-ink-soft">/ {m.durationDays} days</span>
                </div>
              </div>
            </div>

            <Card className="flex flex-col gap-5">
              {tiers.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  This membership isn&apos;t available right now.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {multiTier && (
                    <h2 className="font-display text-lg font-extrabold text-ink">Choose a tier</h2>
                  )}
                  {tiers.map((t) => {
                    const selected = selectedTier?.id === t.id;
                    const soldOut = t.remaining === 0;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setSelectedTierId((prev) => (prev === t.id ? null : t.id))}
                        disabled={soldOut}
                        aria-pressed={selected}
                        className={[
                          'flex w-full items-start justify-between gap-4 rounded-card border-[2.5px] bg-white px-4 py-3.5 text-left shadow-offset-sm transition-[transform,box-shadow,border-color] duration-150',
                          selected ? 'border-coral-deep' : 'border-ink',
                          soldOut
                            ? 'opacity-60'
                            : 'hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-offset',
                        ].join(' ')}
                      >
                        <div className="min-w-0">
                          <p className="font-display text-lg font-extrabold text-ink">{t.name}</p>
                          {t.description && (
                            <p className="mt-0.5 text-sm text-text-secondary">{t.description}</p>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="font-display text-xl font-extrabold text-ink">{formatPaise(t.pricePaise, currency)}</p>
                          <p className="text-xs text-ink-soft">/ {t.durationDays} days</p>
                          {soldOut ? (
                            <p className="mt-1 text-xs font-semibold text-petal-red">Sold out</p>
                          ) : (
                            t.remaining != null && (
                              <p className="mt-1 text-xs text-ink-soft">{t.remaining} left</p>
                            )
                          )}
                        </div>
                      </button>
                    );
                  })}
                  <p className="text-xs text-text-secondary">
                    {selectedTier
                      ? 'Review and confirm in the bar below.'
                      : multiTier
                        ? 'Pick a tier to continue.'
                        : 'Tap the plan to continue.'}
                  </p>
                </div>
              )}

              <Benefits benefits={selectedTier?.benefits ?? m.benefits} />

              {m.terms && (
                <div>
                  <h2 className="font-display text-lg font-extrabold text-ink">Terms</h2>
                  <p className="mt-2 whitespace-pre-line text-sm text-text-secondary">{m.terms}</p>
                </div>
              )}

              {m.venueId && (
                <Link href={`/venues/${m.venueId}`} className="text-sm font-semibold text-coral-deep underline">
                  More at {m.scopeName}
                </Link>
              )}
            </Card>

            {m.brand && (
              <section className="mt-6">
                <OrgBrandBlock brand={m.brand} org={orgQ.data} variant="full" label="Offered by" />
              </section>
            )}

            {/* Q&A with the organiser (#106 questions threads). */}
            <section className="mt-8">
              <QuestionsSection subjectType="membership" subjectId={m.id} subjectName={m.name} />
            </section>
          </>
        )}
      </main>

      {selectedTier && (
        <StickyActionBar
          maxWidthClass="max-w-3xl"
          summary={
            <>
              <span className="font-display font-extrabold text-ink">{selectedTier.name}</span>
              <span className="text-text-secondary">
                {' '}· {formatPaise(selectedTier.pricePaise, currency)} / {selectedTier.durationDays} days
              </span>
            </>
          }
          action={
            <Button onClick={() => buy(selectedTier)}>
              {selectedTier.pricePaise === 0
                ? 'Get membership'
                : `Buy · ${formatPaise(selectedTier.pricePaise, currency)}`}
            </Button>
          }
        />
      )}
    </div>
  );
}
