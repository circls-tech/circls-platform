'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { apiDownload } from '@/lib/api/client';
import { useAdminPartnerUsers } from '@/lib/api/queries';
import type { AdminPartnerUserRow } from '@/lib/api/types';

const STATUS_TONE: Record<AdminPartnerUserRow['tenantStatus'], string> = {
  active: 'bg-emerald-100 text-emerald-800',
  suspended: 'bg-rose-100 text-rose-800',
};

const ROLE_TONE: Record<AdminPartnerUserRow['role'], string> = {
  owner: 'bg-indigo-100 text-indigo-800',
  manager: 'bg-sky-100 text-sky-800',
  staff: 'bg-slate-100 text-slate-700',
  readonly: 'bg-slate-100 text-slate-500',
};

function Pill({ tone, label }: { tone: string; label: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

const IST_DATETIME = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

const RANGES = [
  { key: 'all', label: 'All time', hours: null },
  { key: '24h', label: 'Last 24 hours', hours: 24 },
  { key: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { key: '30d', label: 'Last 30 days', hours: 24 * 30 },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

function sinceForRange(range: RangeKey): string | undefined {
  const hours = RANGES.find((r) => r.key === range)?.hours ?? null;
  if (hours == null) return undefined;
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

export default function PartnerUsersPage() {
  const [searchInput, setSearchInput] = useState('');
  const [range, setRange] = useState<RangeKey>('all');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const search = useDebounced(searchInput, 300);

  const since = useMemo(() => sinceForRange(range), [range]);
  const filters = useMemo(
    () => ({ q: search.trim() || undefined, since }),
    [search, since],
  );

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useAdminPartnerUsers(filters);

  const rows: AdminPartnerUserRow[] = useMemo(
    () => data?.pages.flatMap((p) => p.rows) ?? [],
    [data],
  );

  async function downloadCsv() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const sp = new URLSearchParams({ format: 'csv' });
      if (filters.q) sp.set('q', filters.q);
      if (filters.since) sp.set('since', filters.since);
      const stamp = new Date().toISOString().slice(0, 10);
      await apiDownload(`/v1/admin/users/partners?${sp.toString()}`, `partner-users-${stamp}.csv`);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Partner users</h1>
          <p className="text-sm text-slate-500">
            Every partner-side account — one row per team membership, with tenant rollups.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as RangeKey)}
            className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-slate-400 focus:outline-none"
            aria-label="Joined range"
          >
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                Joined: {r.label}
              </option>
            ))}
          </select>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search person or tenant…"
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-slate-400 focus:outline-none sm:w-64"
          />
          <button
            type="button"
            onClick={() => void downloadCsv()}
            disabled={downloading}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-700 disabled:opacity-50"
          >
            {downloading ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
      </div>
      {downloadError && <p className="text-sm text-red-600">CSV download failed: {downloadError}</p>}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[1100px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">User</th>
              <th className="px-4 py-2 font-medium">Contact</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Tenant</th>
              <th className="px-4 py-2 font-medium">Tenant status</th>
              <th className="px-4 py-2 font-medium">Subscription</th>
              <th className="px-4 py-2 text-right font-medium">Team</th>
              <th className="px-4 py-2 text-right font-medium">Venues</th>
              <th className="px-4 py-2 text-right font-medium">Bookings (30d)</th>
              <th className="px-4 py-2 text-right font-medium">Logins</th>
              <th className="px-4 py-2 font-medium">Last login</th>
              <th className="px-4 py-2 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={12} className="px-4 py-8 text-center text-sm text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={12} className="px-4 py-8 text-center text-sm text-red-600">
                  Failed to load: {error instanceof Error ? error.message : 'unknown error'}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-4 py-8 text-center text-sm text-slate-400">
                  No partner users found.
                </td>
              </tr>
            )}
            {rows.map((m) => (
              <tr key={`${m.tenantId}:${m.userId}`}>
                <td className="px-4 py-2.5 font-medium text-slate-900">
                  {m.displayName ?? <span className="text-slate-400">(no name)</span>}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-600">
                  <div>{m.email ?? '—'}</div>
                  <div className="text-slate-400">{m.phoneE164 ?? ''}</div>
                </td>
                <td className="px-4 py-2.5">
                  <Pill tone={ROLE_TONE[m.role] ?? 'bg-slate-100 text-slate-600'} label={m.role} />
                </td>
                <td className="px-4 py-2.5">
                  <Link href={`/tenants/${m.tenantId}`} className="text-slate-900 hover:underline">
                    {m.tenantName}
                  </Link>
                  <div className="font-mono text-xs text-slate-400">{m.tenantSlug}</div>
                </td>
                <td className="px-4 py-2.5">
                  <Pill
                    tone={STATUS_TONE[m.tenantStatus] ?? 'bg-slate-100 text-slate-600'}
                    label={m.tenantStatus}
                  />
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-600">{m.subscriptionStatus}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{m.teamSize}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{m.venueCount}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{m.tenantBookings30d}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{m.loginCount}</td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {m.lastLoginAt ? IST_DATETIME.format(new Date(m.lastLoginAt)) : '—'}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {IST_DATETIME.format(new Date(m.memberSince))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hasNextPage && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
            className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
