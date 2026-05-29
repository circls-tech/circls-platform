'use client';

import { useMemo, useState } from 'react';
import { useAdminListings, useApproveListing, useRejectListing } from '@/lib/api/queries';
import { ApiError } from '@/lib/api/client';
import type { AdminListingRow, AdminListingType } from '@/lib/api/types';

const IST_DATE = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return IST_DATE.format(new Date(iso));
}

const TYPES: { id: AdminListingType; label: string; lower: string }[] = [
  { id: 'venue', label: 'Venues', lower: 'venues' },
  { id: 'arena', label: 'Arenas', lower: 'arenas' },
  { id: 'event', label: 'Events', lower: 'events' },
  { id: 'membership', label: 'Memberships', lower: 'memberships' },
];

export default function ListingsPage() {
  const [type, setType] = useState<AdminListingType>('venue');

  const { data, isLoading, isError, error } = useAdminListings(type, 'pending_review');

  const approve = useApproveListing();
  const reject = useRejectListing();
  const [actionError, setActionError] = useState<string | null>(null);

  const rows: AdminListingRow[] = useMemo(() => data?.rows ?? [], [data]);

  const busy = approve.isPending || reject.isPending;
  const activeType = TYPES.find((t) => t.id === type)!;

  function handleActionError(err: unknown) {
    if (err instanceof ApiError) {
      if (err.status === 409 || err.code === 'listing_not_pending') {
        setActionError('This listing is no longer pending review.');
        return;
      }
      setActionError(err.message);
      return;
    }
    setActionError(err instanceof Error ? err.message : 'unknown error');
  }

  function onApprove(row: AdminListingRow) {
    setActionError(null);
    approve.mutate(
      { type: row.type, id: row.id },
      { onError: handleActionError },
    );
  }

  function onReject(row: AdminListingRow) {
    const reason = window.prompt(
      `Reason for rejecting "${row.name}" (optional):`,
    );
    if (reason == null) return; // cancelled
    const trimmed = reason.trim();
    setActionError(null);
    reject.mutate(
      { type: row.type, id: row.id, reason: trimmed === '' ? undefined : trimmed },
      { onError: handleActionError },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Review queue</h1>
          <p className="text-sm text-slate-500">
            Listings awaiting Circls review before they go live.
          </p>
        </div>
        <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5 shadow-sm">
          {TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setType(t.id)}
              className={[
                'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                type === t.id
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:text-slate-900',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {actionError}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Venue / Org</th>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Submitted</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-red-600">
                  Failed to load: {error instanceof Error ? error.message : 'unknown error'}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-400">
                  No {activeType.lower} awaiting review.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={`${r.type}:${r.id}`} className="transition-colors hover:bg-slate-50">
                <td className="px-4 py-2.5 text-slate-700">{r.tenantName}</td>
                <td className="px-4 py-2.5 font-medium text-slate-900">{r.name}</td>
                <td className="px-4 py-2.5 text-xs text-slate-500">{fmtDate(r.createdAt)}</td>
                <td className="px-4 py-2.5 text-right">
                  <div className="inline-flex gap-2">
                    <button
                      type="button"
                      onClick={() => onApprove(r)}
                      disabled={busy}
                      className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {approve.isPending ? 'Working…' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onReject(r)}
                      disabled={busy}
                      className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                    >
                      {reject.isPending ? 'Working…' : 'Reject'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
