'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useMe, useMyTenants, useVenues } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';
import { Badge, Card } from '@/lib/ui';

// ── Stat Card ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string;
  sublabel: string;
}

function StatCard({ label, value, sublabel }: StatCardProps) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <Badge tone="neutral" label="preview" />
      </div>
      <p className="text-3xl font-bold tracking-tight text-slate-900">{value}</p>
      <p className="text-xs text-slate-400">{sublabel}</p>
    </Card>
  );
}

// ── Venues Section ────────────────────────────────────────────────────────────

function VenuesSection({ tenantId }: { tenantId: string }) {
  const { data: venues, isLoading } = useVenues(tenantId);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <span className="block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
        Loading venues…
      </div>
    );
  }

  if (!venues || venues.length === 0) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <p className="text-sm text-slate-500">No venues yet. Add your first venue to get started.</p>
        <Link
          href="/venues"
          className="inline-flex items-center justify-center gap-2 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
        >
          ＋ Add venue
        </Link>
      </Card>
    );
  }

  const statusTone = (s: string): 'success' | 'warning' | 'neutral' => {
    if (s === 'active') return 'success';
    if (s === 'inactive' || s === 'suspended') return 'warning';
    return 'neutral';
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {venues.map((venue) => (
          <Link
            key={venue.id}
            href={`/venues/${venue.id}?tenantId=${tenantId}`}
            className="block rounded-[var(--radius)] border border-[#e5e7eb] bg-white p-5 shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="font-semibold text-slate-900">{venue.name}</span>
              <Badge tone={statusTone(venue.status)} label={venue.status} />
            </div>
            {venue.tzName && (
              <p className="mt-1 text-xs text-slate-400">{venue.tzName}</p>
            )}
          </Link>
        ))}
      </div>

      <div className="pt-1">
        <Link
          href="/venues"
          className="inline-flex items-center justify-center gap-2 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
        >
          ＋ Add venue
        </Link>
      </div>
    </div>
  );
}

// ── Dashboard Page ────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const router = useRouter();
  const { data: me } = useMe();
  const { data: tenants, isLoading } = useMyTenants();
  const { activeTenantId, tenants: orgTenants } = useOrg();

  // Redirect new users who have no org yet to the onboarding wizard.
  useEffect(() => {
    if (!isLoading && tenants !== undefined && tenants.length === 0) {
      router.replace('/onboarding');
    }
  }, [isLoading, tenants, router]);

  const activeTenant = orgTenants.find((t) => t.id === activeTenantId) ?? null;
  const identity = me?.displayName ?? me?.phoneE164 ?? me?.email ?? null;

  return (
    <div className="flex flex-col gap-8">
      {/* ── Header ── */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Good to see you{activeTenant ? `, ${activeTenant.name}` : ''}
        </h1>
        {identity && (
          <p className="text-sm text-slate-500">Signed in as {identity}</p>
        )}
      </div>

      {/* ── Stat Cards ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
          Overview
        </h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            label="Bookings today"
            value="—"
            sublabel="Live analytics coming soon"
          />
          <StatCard
            label="Revenue · 7d"
            value="—"
            sublabel="Live analytics coming soon"
          />
          <StatCard
            label="Occupancy"
            value="—"
            sublabel="Live analytics coming soon"
          />
        </div>
      </section>

      {/* ── Venues ── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
          Your Venues
        </h2>

        {!activeTenantId ? (
          <Card className="flex flex-col items-start gap-3">
            <p className="text-sm text-slate-500">
              No organisation selected. Pick or create one to see venues.
            </p>
            <Link
              href="/onboarding"
              className="inline-flex items-center justify-center gap-2 rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Set up organisation
            </Link>
          </Card>
        ) : (
          <VenuesSection tenantId={activeTenantId} />
        )}
      </section>
    </div>
  );
}
