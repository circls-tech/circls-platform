'use client';

import Link from 'next/link';
import { useAdminStats } from '@/lib/api/queries';
import { RevenueSection } from '@/components/RevenueSection';

interface TileProps {
  label: string;
  value: number | string;
  sub?: string;
  tone?: 'default' | 'warn' | 'good';
  href?: string;
  /** Brand-sheet petal behind the label chip; defaults to the sky petal. */
  petal?: string;
}

/**
 * Stat tile in the brand-sheet comic style: ink border, hard offset shadow,
 * a petal chip on the label and the figure set in the display face. Mirrors the
 * partner portal's StatCard so both consoles read as one product.
 */
function Tile({ label, value, sub, tone = 'default', href, petal = '#A9C9F2' }: TileProps) {
  const valueColor =
    tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-emerald-700' : 'text-[#17151D]';

  const inner = (
    <div
      className={[
        'flex h-full flex-col justify-between gap-3 rounded-[var(--radius)] border-2 border-[#17151D] bg-white p-4',
        'shadow-[4px_4px_0_#17151D] transition-transform',
        href ? 'hover:-translate-y-0.5' : '',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 rounded-full border-2 border-[#17151D]"
          style={{ backgroundColor: petal }}
        />
        <span className="text-xs font-semibold text-slate-600">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span
          className={`font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight tabular-nums ${valueColor}`}
        >
          {value}
        </span>
        {sub && <span className="text-xs text-slate-500">{sub}</span>}
      </div>
    </div>
  );

  return href ? (
    <Link href={href} className="block h-full">
      {inner}
    </Link>
  ) : (
    inner
  );
}

export default function AdminDashboard() {
  const { data, isLoading, isError, error } = useAdminStats();

  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-extrabold tracking-tight text-[#17151D]">Admin dashboard</h1>
        <p className="text-sm text-red-600">
          Failed to load stats: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-[#17151D]">Platform overview</h1>
        <p className="mt-1 text-sm text-slate-500">
          Aggregates across every tenant on circls.app.
        </p>
      </div>

      <RevenueSection />

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">Tenants</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Total tenants"
            petal="#FCE38A"
            value={data.tenantsTotal}
            sub={`${data.tenantsActive} active`}
            href="/tenants"
          />
          <Tile
            label="Active"
            petal="#BCE3A0"
            value={data.tenantsActive}
            tone="good"
            href="/tenants"
          />
          <Tile
            label="Suspended"
            petal="#FFB0A3"
            value={data.tenantsSuspended}
            tone={data.tenantsSuspended > 0 ? 'warn' : 'default'}
            href="/tenants"
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">Users</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Accounts made"
            petal="#CDBBF7"
            value={data.usersTotal}
            sub={`+${data.usersNew7d} in 7d`}
          />
          <Tile label="New (24h)" petal="#BCE3A0" value={data.usersNew24h} tone="good" />
          <Tile
            label="Active users (24h)"
            petal="#9CE0D4"
            value={data.activeUsers24h}
            sub="signed in or booked"
          />
          <Tile
            label="Active users (30d)"
            petal="#9CE0D4"
            value={data.activeUsers30d}
            sub="signed in or booked"
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">Logins</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Last 24 hours" petal="#F9B4D4" value={data.logins24h} />
          <Tile label="Last 7 days" petal="#F9B4D4" value={data.logins7d} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">Bookings</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Last 24 hours" petal="#FFD2A1" value={data.bookings24h} />
          <Tile label="Last 7 days" petal="#FFD2A1" value={data.bookings7d} />
        </div>
      </section>
    </div>
  );
}
