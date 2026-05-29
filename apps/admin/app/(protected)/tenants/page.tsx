'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useAdminTenants } from '@/lib/api/queries';
import type { AdminTenantListItem } from '@/lib/api/types';

const STATUS_TONE: Record<AdminTenantListItem['status'], string> = {
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

const IST_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export default function TenantsPage() {
  const router = useRouter();
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput, 300);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useAdminTenants(search.trim() || undefined);

  const rows: AdminTenantListItem[] = useMemo(
    () => data?.pages.flatMap((p) => p.rows) ?? [],
    [data],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Tenants</h1>
          <p className="text-sm text-slate-500">
            Every tenant on the platform — search by name or slug.
          </p>
        </div>
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search name or slug…"
          className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-slate-400 focus:outline-none sm:w-72"
        />
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Slug</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Venues</th>
              <th className="px-4 py-2 text-right font-medium">Bookings (30d)</th>
              <th className="px-4 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-red-600">
                  Failed to load: {error instanceof Error ? error.message : 'unknown error'}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">
                  No tenants found.
                </td>
              </tr>
            )}
            {rows.map((t) => (
              <tr
                key={t.id}
                className="cursor-pointer transition-colors hover:bg-slate-50"
                onClick={() => router.push(`/tenants/${t.id}`)}
              >
                <td className="px-4 py-2.5 font-medium text-slate-900">
                  <Link
                    href={`/tenants/${t.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="hover:underline"
                  >
                    {t.name}
                  </Link>
                </td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{t.slug}</td>
                <td className="px-4 py-2.5">
                  <Pill tone={STATUS_TONE[t.status] ?? 'bg-slate-100 text-slate-600'} label={t.status} />
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{t.venueCount}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{t.bookingCount30d}</td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {IST_DATE.format(new Date(t.createdAt))}
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
