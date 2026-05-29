'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useTenantAuditLog } from '@/lib/api/queries';
import type { TenantAuditLogItem } from '@/lib/api/types';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function actionTone(action: string): string {
  if (action.includes('create') || action.includes('reactivated')) return 'bg-emerald-100 text-emerald-800';
  if (action.includes('delete') || action.includes('cancel') || action.includes('suspended') || action.includes('reject')) {
    return 'bg-rose-100 text-rose-800';
  }
  if (action.includes('update') || action.includes('reprice') || action.includes('block')) {
    return 'bg-amber-100 text-amber-800';
  }
  return 'bg-slate-100 text-slate-700';
}

function DiffToggle({ before, after }: { before: unknown; after: unknown }) {
  const [open, setOpen] = useState(false);
  const hasDiff = before != null || after != null;
  if (!hasDiff) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-medium text-blue-700 hover:underline"
      >
        {open ? 'Hide' : 'View'}
      </button>
      {open && (
        <pre className="mt-2 max-w-md overflow-auto rounded bg-slate-50 p-2 text-xs text-slate-700 whitespace-pre-wrap break-all">
          {JSON.stringify({ before, after }, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function TenantAuditTimelinePage() {
  const params = useParams<{ id: string }>();
  const tenantId = params.id;

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useTenantAuditLog(tenantId);

  const rows: TenantAuditLogItem[] = data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/tenants/${tenantId}`}
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          &larr; Tenant
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Audit timeline</h1>
        <p className="text-sm text-slate-500">Every recorded action for this tenant, newest first.</p>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">When (IST)</th>
              <th className="px-4 py-2 font-medium">Actor</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Entity</th>
              <th className="px-4 py-2 font-medium">Diff</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {isError && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-red-600">
                  Failed to load: {error instanceof Error ? error.message : 'unknown error'}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-400">
                  No audit events.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-4 py-2.5 whitespace-nowrap font-mono text-xs text-slate-500">
                  {IST_FMT.format(new Date(r.createdAt))}
                </td>
                <td className="px-4 py-2.5 text-slate-700">
                  {r.actorName ?? (
                    <span className="text-slate-400">
                      {r.actorUserId ? `${r.actorUserId.slice(0, 8)}…` : '—'}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${actionTone(r.action)}`}>
                    {r.action}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-slate-800">{r.entityType}</span>
                  {r.entityId && (
                    <span className="ml-1 font-mono text-xs text-slate-500">
                      {r.entityId.slice(0, 8)}…
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <DiffToggle before={r.before} after={r.after} />
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
