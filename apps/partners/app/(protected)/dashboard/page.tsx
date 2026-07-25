'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useMe, useMyTenants, useVenues, useAnalytics } from '@/lib/api/queries';
import { useOrg } from '@/lib/org_context';
import { type CurrencyCode, asCurrencyCode, formatMoney, useCurrency } from '@/lib/currency';
import { Card, StatusPill } from '@/lib/ui';
import type { AnalyticsTrendDay, MoneyByCurrency } from '@/lib/api/types';

// ── Stat Card ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string;
  sublabel: string;
  loading?: boolean;
  /** Navigator-petal pastel behind the icon chip (brand sheet). */
  petal: string;
  /** Stroke icon in the chip; 'currency' renders ₹ or $ per the org currency. */
  icon: 'calendar' | 'currency' | 'trend' | 'chart';
}

function StatIcon({ name, currency, size = 20 }: { name: StatCardProps['icon']; currency: CurrencyCode; size?: number }) {
  const common = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'calendar':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      );
    case 'currency':
      return currency === 'USD' ? (
        <svg {...common}>
          <line x1="12" y1="2" x2="12" y2="22" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
      ) : (
        <svg {...common}>
          <path d="M6 3h12" />
          <path d="M6 8h12" />
          <path d="m6 13 8.5 8" />
          <path d="M6 13h3" />
          <path d="M9 13c6.667 0 6.667-10 0-10" />
        </svg>
      );
    case 'trend':
      return (
        <svg {...common}>
          <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
          <polyline points="16 7 22 7 22 13" />
        </svg>
      );
    case 'chart':
      return (
        <svg {...common}>
          <line x1="6" y1="20" x2="6" y2="16" />
          <line x1="12" y1="20" x2="12" y2="10" />
          <line x1="18" y1="20" x2="18" y2="4" />
        </svg>
      );
  }
}

function StatCard({ label, value, sublabel, loading, petal, icon }: StatCardProps) {
  const currency = useCurrency();
  return (
    <Card className="h-full">
      <div className="flex h-full flex-col justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-2 border-[#17151D] text-[#17151D]"
            style={{ backgroundColor: petal }}
          >
            <StatIcon name={icon} currency={currency} size={15} />
          </span>
          <p className="font-[family-name:var(--font-body)] text-xs font-semibold text-slate-600">{label}</p>
        </div>
        {loading ? (
          <div className="h-8 w-20 animate-pulse rounded-md bg-slate-100" />
        ) : (
          <p className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight text-[#17151D]">{value}</p>
        )}
        <p className="font-[family-name:var(--font-body)] text-xs text-slate-500">{sublabel}</p>
      </div>
    </Card>
  );
}

// ── 7-day Trend Chart ─────────────────────────────────────────────────────────

function TrendChart({ trend, currency }: { trend: AnalyticsTrendDay[]; currency: CurrencyCode }) {
  const maxRevenue = Math.max(...trend.map((d) => d.revenuePaise), 0);
  const allZero = maxRevenue === 0;

  /** Format 'YYYY-MM-DD' → short weekday or day number */
  function dayLabel(date: string): string {
    const d = new Date(`${date}T00:00:00`);
    // Use abbreviated weekday so bars are clearly labelled
    return d.toLocaleDateString('en-IN', { weekday: 'short' });
  }

  const MAX_BAR_HEIGHT_PX = 96; // h-24
  const MIN_BAR_HEIGHT_PX = 6;  // min visible for non-zero days

  if (allZero) {
    return (
      <p className="text-sm text-slate-400 py-2">No bookings in the last 7 days yet.</p>
    );
  }

  return (
    <div className="flex items-end gap-2 h-32 border-l-2 border-b-2 border-[#17151D] pl-2 pt-2">
      {trend.map((day) => {
        const heightPx =
          day.revenuePaise === 0
            ? 2 // baseline bar for zero-revenue days
            : Math.max(
                MIN_BAR_HEIGHT_PX,
                Math.round((day.revenuePaise / maxRevenue) * MAX_BAR_HEIGHT_PX),
              );

        const tooltipText = `${dayLabel(day.date)}: ${formatMoney(day.revenuePaise, currency)} · ${day.bookings} booking${day.bookings === 1 ? '' : 's'}`;

        return (
          <div
            key={day.date}
            className="flex flex-1 flex-col items-center gap-1"
          >
            <div
              className={[
                'w-full rounded-t-sm transition-all',
                day.revenuePaise === 0
                  ? 'bg-brand-100'
                  : 'border-2 border-b-0 border-[#17151D] bg-brand-600 hover:bg-brand-700',
              ].join(' ')}
              style={{ height: `${heightPx}px` }}
              title={tooltipText}
            />
            <span className="text-[10px] font-semibold text-[#17151D] leading-none">
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
          className="inline-flex items-center justify-center gap-2 rounded-[var(--radius)] border-2 border-[#17151D] bg-[#FFD2A1] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5"
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
            className="block rounded-[var(--radius)] border-2 border-[#17151D] bg-white p-5 shadow-[4px_4px_0_#17151D] transition-transform hover:-translate-x-0.5 hover:-translate-y-0.5"
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
          className="inline-flex items-center justify-center gap-2 rounded-[var(--radius)] border-2 border-[#17151D] bg-[#FFD2A1] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5"
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
  // a tz parameter and perform per-venue aggregation to fix this. Revenue IS
  // aggregated per currency on the backend: a tenant with both US and India
  // venues gets one bucket/trend series per currency.
  const { data: analytics, isLoading: analyticsLoading } = useAnalytics(
    activeTenantId ?? '',
  );
  const currency = useCurrency();

  // Redirect new users who have no org yet to the onboarding wizard.
  useEffect(() => {
    if (!isLoading && tenants !== undefined && tenants.length === 0) {
      router.replace('/onboarding');
    }
  }, [isLoading, tenants, router]);

  const activeTenant = orgTenants.find((t) => t.id === activeTenantId) ?? null;
  const identity = me?.displayName ?? me?.phoneE164 ?? me?.email ?? null;

  // Derived stat values (safe for zero state). Revenue buckets are per
  // currency — usually one; a mixed-currency org shows "₹1,200 · $50".
  const fmtBuckets = (buckets: MoneyByCurrency[] | undefined): string =>
    !buckets || buckets.length === 0
      ? formatMoney(0, currency)
      : buckets.map((b) => formatMoney(b.amountMinor, asCurrencyCode(b.currency))).join(' · ');
  const bookingsToday = analytics?.bookingsToday ?? 0;
  const revenueToday = fmtBuckets(analytics?.revenueToday);
  const revenue7d = fmtBuckets(analytics?.revenue7d);
  const occupancy7dPct = analytics?.occupancy7dPct ?? 0;

  return (
    <div className="flex flex-col gap-8">
      {/* ── Header ── */}
      <div className="flex flex-col gap-1">
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold tracking-tight text-[#17151D]">
          Good to see you{activeTenant ? `, ${activeTenant.name}` : ''}
        </h1>
        {identity && (
          <p className="text-sm text-slate-500">Signed in as {identity}</p>
        )}
      </div>

      {/* ── Stat Cards ── */}
      <section className="flex flex-col gap-3">
        <h2 className="font-[family-name:var(--font-accent)] text-2xl font-bold text-[#EE5C2B]">
          Overview
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Bookings today"
            value={String(bookingsToday)}
            sublabel="Confirmed bookings for today"
            loading={analyticsLoading && Boolean(activeTenantId)}
            petal="#FCE38A"
            icon="calendar"
          />
          <StatCard
            label="Revenue today"
            value={revenueToday}
            sublabel="Revenue collected today"
            loading={analyticsLoading && Boolean(activeTenantId)}
            petal="#FFB0A3"
            icon="currency"
          />
          <StatCard
            label="Revenue · 7d"
            value={revenue7d}
            sublabel="Total revenue last 7 days"
            loading={analyticsLoading && Boolean(activeTenantId)}
            petal="#F9B4D4"
            icon="trend"
          />
          <StatCard
            label="Occupancy · 7d"
            value={`${occupancy7dPct}%`}
            sublabel="Slot utilisation last 7 days"
            loading={analyticsLoading && Boolean(activeTenantId)}
            petal="#A9C9F2"
            icon="chart"
          />
        </div>
      </section>

      {/* ── 7-day trend chart ── */}
      {activeTenantId && (
        <section className="flex flex-col gap-3">
          <h2 className="font-[family-name:var(--font-accent)] text-2xl font-bold text-[#EE5C2B]">
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
            ) : analytics && analytics.trend7d.length === 0 ? (
              <p className="text-sm text-slate-400 py-2">No bookings in the last 7 days yet.</p>
            ) : analytics ? (
              // One chart per currency with revenue — usually exactly one.
              <div className="flex flex-col gap-4">
                {analytics.trend7d.map((series) => (
                  <div key={series.currency}>
                    {analytics.trend7d.length > 1 && (
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        {series.currency}
                      </p>
                    )}
                    <TrendChart trend={series.days} currency={asCurrencyCode(series.currency)} />
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
        </section>
      )}

      {/* ── Venues ── */}
      <section className="flex flex-col gap-3">
        <h2 className="font-[family-name:var(--font-accent)] text-2xl font-bold text-[#EE5C2B]">
          Your Venues
        </h2>

        {!activeTenantId ? (
          <Card className="flex flex-col items-start gap-3">
            <p className="text-sm text-slate-500">
              No organisation selected. Pick or create one to see venues.
            </p>
            <Link
              href="/onboarding"
              className="inline-flex items-center justify-center gap-2 rounded-[var(--radius)] border-2 border-[#17151D] bg-[#FFD2A1] px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[3px_3px_0_#17151D] transition-transform hover:-translate-y-0.5"
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
