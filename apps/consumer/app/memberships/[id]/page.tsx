'use client';
import { use } from 'react';
import Link from 'next/link';
import { Header } from '@/components/Header';
import { BackBar } from '@/components/BackBar';
import { useMembership } from '@/lib/api/consumer';
import { useAuth } from '@/lib/firebase/auth_context';
import { formatPaise } from '@/lib/format';
import { useCheckoutModal } from '@/lib/checkout/CheckoutProvider';
import { Badge, Button, Card } from '@/lib/ui';

/** Render benefits only when they are a simple string[] or a flat string→string/number
 *  map. The field is an opaque JSONB blob, so anything else is skipped. */
function Benefits({ benefits }: { benefits: Record<string, unknown> }) {
  const items: string[] = Array.isArray(benefits)
    ? (benefits as unknown[]).filter((b): b is string => typeof b === 'string')
    : Object.entries(benefits)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
        .map(([k, v]) => `${k}: ${v}`);
  if (items.length === 0) return null;
  return (
    <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-text-secondary">
      {items.map((b) => <li key={b}>{b}</li>)}
    </ul>
  );
}

export default function MembershipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const membershipQ = useMembership(id);
  const { openCheckout } = useCheckoutModal();
  const { user } = useAuth();
  const m = membershipQ.data;

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 pt-8 pb-8">
        <BackBar />
        {membershipQ.isLoading ? (
          <p className="text-sm text-text-secondary">Loading membership…</p>
        ) : membershipQ.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {membershipQ.error instanceof Error ? membershipQ.error.message : 'Failed to load membership'}
          </p>
        ) : !m ? (
          <p className="text-sm text-text-secondary">Membership not found.</p>
        ) : (
          <>
            <div className="mb-6 overflow-hidden rounded-card border-[2.5px] border-ink bg-lav p-6 text-ink shadow-offset">
              <div className="flex items-center gap-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-ink-soft">{m.scopeName}</p>
                {m.venueId === null && <Badge tone="neutral" label="Brand-wide" />}
              </div>
              <h1 className="mt-1 font-display text-4xl font-extrabold">{m.name}</h1>
              {m.description && <p className="mt-2 text-sm text-ink-soft">{m.description}</p>}
              <div className="mt-4 font-display text-2xl font-extrabold">
                {formatPaise(m.pricePaise)}{' '}
                <span className="font-sans text-xs font-medium text-ink-soft">/ {m.durationDays} days</span>
              </div>
            </div>

            <Card className="flex flex-col gap-3">
              <Benefits benefits={m.benefits} />
              {m.venueId && (
                <Link href={`/venues/${m.venueId}`} className="text-sm font-semibold text-coral-deep underline">
                  More at {m.scopeName}
                </Link>
              )}
              <div className="pt-2">
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
          </>
        )}
      </main>
    </div>
  );
}
