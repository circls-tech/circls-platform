'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useMe, useMyTenants, useVenues, useAnalytics } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';
import { Card, StatusPill } from '@/lib/ui';
import type { AnalyticsTrendDay } from '@/lib/api/types';

// ── Stat Card ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string;
  sublabel: string;
  loading?: boolean;
}

function StatCard({ label, value, sublabel, loading }: StatCardProps) {
  return (
    <Card className="flex flex-col gap-3">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      {loading ? (
        <div className="h-9 w-24 animate-pulse rounded-md bg-slate-100" />
      ) : (
        <p className="text-3xl font-bold tracking-tight text-slate-900">{value}</p>
      )}
      <p className="text-xs text-slate-400">{sublabel}</p>
    </Card>
  );
}

// ── 7-day Trend Chart ─────────────────────────────────────────────────────────

function TrendChart({ trend }: { trend: AnalyticsTrendDay[] }) {
  const maxRevenue = Math.max(...trend.map((d) => d.revenuePaise), 0);
  const allZero = maxRevenue === 0;

  /** Format 'YYYY-MM-DD' → short weekday or day number */
  function dayLabel(date: string): string {
    const d = new Date(`${date}T00:00:00`);
    // Use abbreviated weekday so bars are clearly labelled
    return d.toLocaleDateString('en-IN', { weekday: 'short' });
  }

  /** Format paise as ₹N (no decimals) */
  function fmtRupees(paise: number): string {
    return `₹${Math.round(paise / 100)}`;
  }

  const MAX_BAR_HEIGHT_PX = 96; // h-24
  const MIN_BAR_HEIGHT_PX = 6;  // min visible for non-zero days

  if (allZero) {
    return (
      <p className="text-sm text-slate-400 py-2">No bookings in the last 7 days yet.</p>
    );
  }

  return (
    <div className="flex items-end gap-2 h-32 pt-2">
      {trend.map((day) => {
        const heightPx =
          day.revenuePaise === 0
            ? 2 // baseline bar for zero-revenue days
            : Math.max(
                MIN_BAR_HEIGHT_PX,
                Math.round((day.revenuePaise / maxRevenue) * MAX_BAR_HEIGHT_PX),
              );

        const tooltipText = `${dayLabel(day.date)}: ${fmtRupees(day.revenuePaise)} · ${day.bookings} booking${day.bookings === 1 ? '' : 's'}`;

        return (
          <div
            key={day.date}
            className="flex flex-1 flex-col items-center gap-1"
          >
            <div
              className={[
                'w-full rounded-t-sm transition-all',
                day.revenuePaise === 0
                  ? 'bg-slate-100'
                  : 'bg-slate-700 hover:bg-slate-600',
              ].join(' ')}
              style={{ height: `${heightPx}px` }}
              title={tooltipText}
            />
            <span className="text-[10px] text-slate-400 leading-none">
              {dayLabel(day.date)}
            </span>
          </div>
        );
      })}
    </div>
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
              <StatusPill status={venue.status} />
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

  // NOTE: org-wide analytics (bookingsToday, revenue, occupancy) are computed
  // in IST (Asia/Kolkata) on the backend. Multi-venue timezone support for the
  // dashboard is a known deferred limitation — the backend would need to accept
  // a tz parameter and perform per-venue aggregation to fix this.
  const { data: analytics, isLoading: analyticsLoading } = useAnalytics(
    activeTenantId ?? '',
  );

  // Redirect new users who have no org yet to the onboarding wizard.
  useEffect(() => {
    if (!isLoading && tenants !== undefined && tenants.length === 0) {
      router.replace('/onboarding');
    }
  }, [isLoading, tenants, router]);

  const activeTenant = orgTenants.find((t) => t.id === activeTenantId) ?? null;
  const identity = me?.displayName ?? me?.phoneE164 ?? me?.email ?? null;

  // Derived stat values (safe for zero state)
  const bookingsToday = analytics?.bookingsToday ?? 0;
  const revenueTodayRupees = analytics ? Math.round(analytics.revenueTodayPaise / 100) : 0;
  const revenue7dRupees = analytics ? Math.round(analytics.revenue7dPaise / 100) : 0;
  const occupancy7dPct = analytics?.occupancy7dPct ?? 0;

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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Bookings today"
            value={String(bookingsToday)}
            sublabel="Confirmed bookings for today"
            loading={analyticsLoading && Boolean(activeTenantId)}
          />
          <StatCard
            label="Revenue today"
            value={`₹${revenueTodayRupees}`}
            sublabel="Revenue collected today"
            loading={analyticsLoading && Boolean(activeTenantId)}
          />
          <StatCard
            label="Revenue · 7d"
            value={`₹${revenue7dRupees}`}
            sublabel="Total revenue last 7 days"
            loading={analyticsLoading && Boolean(activeTenantId)}
          />
          <StatCard
            label="Occupancy · 7d"
            value={`${occupancy7dPct}%`}
            sublabel="Slot utilisation last 7 days"
            loading={analyticsLoading && Boolean(activeTenantId)}
          />
        </div>
      </section>

      {/* ── 7-day trend chart ── */}
      {activeTenantId && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400">
            Last 7 days
          </h2>
          <Card title="Revenue trend">
            {analyticsLoading ? (
              <div className="flex items-end gap-2 h-32 pt-2">
                {Array.from({ length: 7 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex flex-1 flex-col items-center gap-1"
                  >
                    <div
                      className="w-full animate-pulse rounded-t-sm bg-slate-100"
                      style={{ height: `${24 + (i % 3) * 24}px` }}
                    />
                    <div className="h-2 w-6 animate-pulse rounded bg-slate-100" />
                  </div>
                ))}
              </div>
            ) : analytics?.trend7d ? (
              <TrendChart trend={analytics.trend7d} />
            ) : null}
          </Card>
        </section>
      )}

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
