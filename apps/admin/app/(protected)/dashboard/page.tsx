'use client';

import Link from 'next/link';
import { useAdminStats } from '@/lib/api/queries';

interface TileProps {
  label: string;
  value: number | string;
  sub?: string;
  tone?: 'default' | 'warn' | 'good';
  href?: string;
}

function Tile({ label, value, sub, tone = 'default', href }: TileProps) {
  const toneRing =
    tone === 'warn'
      ? 'ring-1 ring-amber-200'
      : tone === 'good'
        ? 'ring-1 ring-emerald-200'
        : 'ring-1 ring-slate-200';
  const valueColor =
    tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-emerald-700' : 'text-slate-900';

  const inner = (
    <div
      className={`flex h-full flex-col justify-between rounded-lg bg-white p-4 transition-shadow hover:shadow-sm ${toneRing}`}
    >
      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
      <div className="mt-2 flex items-baseline gap-2">
        <span className={`text-3xl font-semibold tabular-nums ${valueColor}`}>{value}</span>
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
        <h1 className="text-2xl font-semibold">Admin dashboard</h1>
        <p className="text-sm text-red-600">
          Failed to load stats: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Platform overview</h1>
        <p className="mt-1 text-sm text-slate-500">
          Aggregates across every tenant on circls.app.
        </p>
      </div>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">Tenants</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Total tenants"
            value={data.tenantsTotal}
            sub={`${data.tenantsActive} active`}
            href="/tenants"
          />
          <Tile
            label="Active"
            value={data.tenantsActive}
            tone="good"
            href="/tenants"
          />
          <Tile
            label="Suspended"
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
            value={data.usersTotal}
            sub={`+${data.usersNew7d} in 7d`}
          />
          <Tile label="New (24h)" value={data.usersNew24h} tone="good" />
          <Tile
            label="Active users (24h)"
            value={data.activeUsers24h}
            sub="with activity"
          />
          <Tile
            label="Active users (30d)"
            value={data.activeUsers30d}
            sub="with activity"
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">Logins</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Last 24 hours" value={data.logins24h} />
          <Tile label="Last 7 days" value={data.logins7d} />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">Bookings</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Last 24 hours" value={data.bookings24h} />
          <Tile label="Last 7 days" value={data.bookings7d} />
        </div>
      </section>
    </div>
  );
}
