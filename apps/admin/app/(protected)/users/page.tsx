'use client';

import { useMemo, useState } from 'react';
import { useEffect } from 'react';
import { apiDownload } from '@/lib/api/client';
import { useAdminConsumerUsers } from '@/lib/api/queries';
import type { AdminConsumerUserRow } from '@/lib/api/types';

const STATUS_TONE: Record<AdminConsumerUserRow['status'], string> = {
  active: 'bg-emerald-100 text-emerald-800',
  suspended: 'bg-rose-100 text-rose-800',
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

export default function ConsumerUsersPage() {
  const [searchInput, setSearchInput] = useState('');
  const [range, setRange] = useState<RangeKey>('all');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const search = useDebounced(searchInput, 300);

  // `since` is pinned per render of the filters (not per request) so pagination
  // cursors stay consistent while the admin pages through results.
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
  } = useAdminConsumerUsers(filters);

  const rows: AdminConsumerUserRow[] = useMemo(
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
      await apiDownload(`/v1/admin/users/consumers?${sp.toString()}`, `consumer-users-${stamp}.csv`);
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
          <h1 className="text-2xl font-semibold text-slate-900">Consumers</h1>
          <p className="text-sm text-slate-500">
            Every consumer account with booking, activity and login rollups.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as RangeKey)}
            className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-slate-400 focus:outline-none"
            aria-label="Signed-up range"
          >
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                Signed up: {r.label}
              </option>
            ))}
          </select>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name, username, email or phone…"
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
              <th className="px-4 py-2 font-medium">Interests</th>
              <th className="px-4 py-2 text-right font-medium">Events booked</th>
              <th className="px-4 py-2 text-right font-medium">Bookings</th>
              <th className="px-4 py-2 text-right font-medium">Events opened</th>
              <th className="px-4 py-2 text-right font-medium">Sessions</th>
              <th className="px-4 py-2 text-right font-medium">Min in app</th>
              <th className="px-4 py-2 text-right font-medium">Logins</th>
              <th className="px-4 py-2 font-medium">Last active</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Signed up</th>
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
                  No users found.
                </td>
              </tr>
            )}
            {rows.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-2.5 font-medium text-slate-900">
                  {u.displayName ?? <span className="text-slate-400">(no name)</span>}
                  {u.username && <div className="font-mono text-xs font-normal text-slate-400">@{u.username}</div>}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-600">
                  <div>{u.email ?? '—'}</div>
                  <div className="text-slate-400">{u.phoneE164 ?? ''}</div>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-600">
                  {u.interests.length > 0 ? u.interests.join(', ') : '—'}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{u.eventsBooked}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{u.totalBookings}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{u.eventsOpened}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{u.sessionCount}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{u.minutesInApp}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{u.loginCount}</td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {u.lastActiveAt ? IST_DATETIME.format(new Date(u.lastActiveAt)) : '—'}
                </td>
                <td className="px-4 py-2.5">
                  <Pill tone={STATUS_TONE[u.status] ?? 'bg-slate-100 text-slate-600'} label={u.status} />
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {IST_DATETIME.format(new Date(u.createdAt))}
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
