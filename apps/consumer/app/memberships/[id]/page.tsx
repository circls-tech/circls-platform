'use client';
import { use } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { OrgBrandBlock } from '@/components/OrgBrandBlock';
import { useMembership, usePublicOrg } from '@/lib/api/consumer';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatPaise } from '@/lib/format';
import { membershipScope } from '@/lib/trust';
import { useCheckoutModal } from '@/lib/checkout/CheckoutProvider';
import type { MembershipBenefits } from '@/lib/api/types';
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

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8">
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
                  {formatPaise(m.pricePaise)}{' '}
                  <span className="font-sans text-xs font-medium text-ink-soft">/ {m.durationDays} days</span>
                </div>
              </div>
            </div>

            <Card className="flex flex-col gap-5">
              <Benefits benefits={m.benefits} />

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

              <div className="pt-1">
                <Button
                  onClick={() => {
                    const prefill: { name?: string; contact?: string } = {};
                    if (user?.displayName) prefill.name = user.displayName;
                    if (user?.phoneNumber) prefill.contact = user.phoneNumber;
                    openCheckout({ kind: 'membership', membershipId: m.id, title: m.name }, prefill);
                  }}
                >
                  {m.pricePaise === 0 ? 'Get membership' : 'Buy'}
                </Button>
              </div>
            </Card>

            {m.brand && (
              <section className="mt-6">
                <OrgBrandBlock brand={m.brand} org={orgQ.data} variant="full" label="Offered by" />
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
