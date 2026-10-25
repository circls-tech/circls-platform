'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ListingName } from '@/components/ListingName';
import { ApiError, apiDownload } from '@/lib/api/client';
import { useAdminEngagement } from '@/lib/api/queries';
import type { AdminEngagementRow, AdminEngagementShelf, AdminEngagementType } from '@/lib/api/types';

const TYPES: { key: AdminEngagementType; label: string; plural: string }[] = [
  { key: 'event', label: 'Events', plural: 'events' },
  { key: 'venue', label: 'Venues', plural: 'venues' },
  { key: 'membership', label: 'Memberships', plural: 'memberships' },
];

type ShelfChoice = AdminEngagementShelf | 'all';

/** The status filter's choices per type, as the API splits them. */
const SHELVES: Record<AdminEngagementType, { key: ShelfChoice; label: string }[]> = {
  event: [
    { key: 'active', label: 'Active' },
    { key: 'completed', label: 'Completed' },
    { key: 'cancelled', label: 'Cancelled' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'all', label: 'All' },
  ],
  venue: [
    { key: 'active', label: 'Active' },
    { key: 'closed', label: 'Closed' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'all', label: 'All' },
  ],
  membership: [
    { key: 'active', label: 'Active' },
    { key: 'inactive', label: 'Inactive' },
    { key: 'rejected', label: 'Rejected' },
    { key: 'all', label: 'All' },
  ],
};

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

/** An event's date as it reads where the event is (a Boston evening stays on its own day). */
function eventDate(startsAt: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timeZone ?? 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(new Date(startsAt));
}

/** The status pill. A published event that ran keeps `published` until the
 *  nightly sweep marks it completed, so it reads "ended" in the meantime. */
function statusLabel(r: AdminEngagementRow): string {
  if (r.shelf === 'completed' && r.status === 'published') return 'ended';
  return r.status.replace(/_/g, ' ');
}

const NUMBER = new Intl.NumberFormat('en-IN');

const SELECT =
  'rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-slate-400 focus:outline-none';

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** A summary number, in the dashboard's tile style. */
function Stat({ label, value, petal }: { label: string; value: number | undefined; petal: string }) {
  return (
    <div className="flex flex-col justify-between gap-3 rounded-[var(--radius)] border-2 border-[#17151D] bg-white p-4 shadow-[4px_4px_0_#17151D]">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 rounded-full border-2 border-[#17151D]"
          style={{ backgroundColor: petal }}
        />
        <span className="text-xs font-semibold text-slate-600">{label}</span>
      </div>
      <span className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight tabular-nums text-[#17151D]">
        {value == null ? '—' : NUMBER.format(value)}
      </span>
    </div>
  );
}

export default function EngagementPage() {
  const [type, setType] = useState<AdminEngagementType>('event');
  // One choice per tab, each starting on Active.
  const [shelves, setShelves] = useState<Record<AdminEngagementType, ShelfChoice>>({
    event: 'active',
    venue: 'active',
    membership: 'active',
  });
  const [range, setRange] = useState<RangeKey>('all');
  const [searchInput, setSearchInput] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const search = useDebounced(searchInput, 300);
  const shelf = shelves[type];

  // `since` is pinned per change of range (not per request) so the offset
  // cursor keeps paging the same result set.
  const since = useMemo(() => sinceForRange(range), [range]);
  const filters = useMemo(
    () => ({ type, shelf, q: search.trim() || undefined, since }),
    [type, shelf, search, since],
  );

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, error } =
    useAdminEngagement(filters);

  const rows = useMemo(() => data?.pages.flatMap((p) => p.rows) ?? [], [data]);
  const totals = data?.pages[0]?.totals;
  const typeInfo = TYPES.find((t) => t.key === type)!;
  const shelfInfo = SHELVES[type].find((s) => s.key === shelf)!;
  // "Active events", "Closed venues"; plain "Events" for All.
  const listedLabel = shelf === 'all' ? typeInfo.label : `${shelfInfo.label} ${typeInfo.plural}`;

  async function downloadCsv() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const sp = new URLSearchParams({ type, shelf, format: 'csv' });
      if (filters.q) sp.set('q', filters.q);
      if (filters.since) sp.set('since', filters.since);
      const stamp = new Date().toISOString().slice(0, 10);
      await apiDownload(`/v1/admin/engagement?${sp.toString()}`, `engagement-${typeInfo.plural}-${stamp}.csv`);
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
          <h1 className="text-2xl font-extrabold tracking-tight text-[#17151D]">Engagement</h1>
          <p className="text-sm text-slate-500">Views, likes, shares and app sales per listing.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as RangeKey)}
            className={SELECT}
            aria-label="Activity range"
          >
            {RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                Activity: {r.label}
              </option>
            ))}
          </select>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search listing or organiser…"
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-slate-400 focus:outline-none sm:w-64"
          />
          <button
            type="button"
            onClick={() => void downloadCsv()}
            disabled={downloading}
            className="whitespace-nowrap rounded-md border-2 border-[#17151D] bg-brand-600 px-4 py-2 text-sm font-medium text-slate-900 shadow-[2px_2px_0_#17151D] hover:bg-brand-700 disabled:opacity-50"
          >
            {downloading ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Listing type">
          {TYPES.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={type === t.key}
              onClick={() => setType(t.key)}
              className={
                type === t.key
                  ? 'rounded-md border border-[#17151D] bg-brand-600 px-3 py-1 text-xs font-medium text-slate-900'
                  : 'rounded-md border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50'
              }
            >
              {t.label}
            </button>
          ))}
        </div>
        <select
          value={shelf}
          onChange={(e) => setShelves((s) => ({ ...s, [type]: e.target.value as ShelfChoice }))}
          className={SELECT}
          aria-label={`${typeInfo.label} status`}
        >
          {SHELVES[type].map((s) => (
            <option key={s.key} value={s.key}>
              Status: {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={listedLabel} value={totals?.listings} petal="#A9C9F2" />
        <Stat label="Views" value={totals?.views} petal="#BCE3A0" />
        <Stat label="Likes" value={totals?.likes} petal="#FFB0A3" />
        <Stat label="Shares" value={totals?.shares} petal="#CDBBF7" />
        <Stat label="App sales" value={totals?.sales} petal="#FCE38A" />
      </div>

      <p className="text-xs text-slate-400">
        Active means live or awaiting review. Shares count links sent or copied, not dismissed share sheets. Likes
        are what is on wishlists now. Views and shares from people who never signed in are not recorded. App sales
        count tickets, court bookings and plans, free sign-ups included. Who liked and shared what is on the{' '}
        <Link href="/users" className="underline">
          Consumers
        </Link>{' '}
        report. A listing customers can open links to its page on the consumer site. CSV export applies the
        current filters and is capped to the first 10,000 rows.
      </p>
      {downloadError && <p className="text-sm text-red-600">CSV download failed: {downloadError}</p>}

      <div className="overflow-x-auto rounded-lg border-2 border-[#17151D] bg-white shadow-[4px_4px_0_#17151D]">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b-2 border-[#17151D] bg-[#FAF3E8] text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Listing</th>
              <th className="px-4 py-2 font-medium">Organiser</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Views</th>
              <th className="px-4 py-2 text-right font-medium" title="Distinct signed-in people who viewed it">
                Viewers
              </th>
              <th className="px-4 py-2 text-right font-medium">Likes</th>
              <th className="px-4 py-2 text-right font-medium">Shares</th>
              <th
                className="px-4 py-2 text-right font-medium"
                title="Tickets, court bookings and plans sold in the consumer app that went through (confirmed, completed or no-show)"
              >
                Sales
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-red-600">
                  {error instanceof ApiError && error.code === 'forbidden_capability'
                    ? 'Your platform role cannot see the engagement report.'
                    : `Failed to load: ${error instanceof Error ? error.message : 'unknown error'}`}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-400">
                  No {listedLabel.toLowerCase()} found.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.itemId}>
                <td className="px-4 py-2.5">
                  <ListingName name={r.name} url={r.url} />
                  {r.startsAt && (
                    <div className="text-xs text-slate-400">
                      {/* The API stands a series by its next date, or its last once all have passed. */}
                      {r.dates > 1
                        ? `${r.dates} dates · ${new Date(r.startsAt).getTime() >= Date.now() ? 'next' : 'last'} `
                        : ''}
                      {eventDate(r.startsAt, r.timeZone)}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-600">
                  <Link href={`/tenants/${r.tenantId}`} className="hover:underline">
                    {r.tenantName}
                  </Link>
                </td>
                <td className="px-4 py-2.5">
                  <span className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                    {statusLabel(r)}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{r.views}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{r.viewers}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{r.likes}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{r.shares}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{r.sales ?? '—'}</td>
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
