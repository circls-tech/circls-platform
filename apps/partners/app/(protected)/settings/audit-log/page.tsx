'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useOrg } from '@/lib/org_context';
import { useTimezone } from '@/lib/timezone_context';
import { useAuditLog } from '@/lib/api/queries';
import type { AuditLogItem } from '@/lib/api/types';
import { Badge } from '@/lib/ui/Badge';
import { Button } from '@/lib/ui/Button';
import { Card } from '@/lib/ui/Card';

function actionTone(action: string): 'success' | 'warning' | 'open' | 'neutral' {
  if (action === 'create') return 'success';
  if (action === 'delete' || action === 'cancel') return 'warning';
  if (action === 'update') return 'open';
  return 'neutral';
}

function DiffToggle({ before, after }: { before: unknown; after: unknown }) {
  const [open, setOpen] = useState(false);
  const hasDiff = before != null || after != null;
  if (!hasDiff) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-medium text-brand-600 hover:underline"
      >
        {open ? 'Hide' : 'View'}
      </button>
      {open && (
        <pre className="mt-2 max-w-xs overflow-auto rounded bg-slate-50 p-2 text-xs text-slate-700 whitespace-pre-wrap break-all">
          {JSON.stringify({ before, after }, null, 2)}
        </pre>
      )}
    </div>
  );
}

// Top-N common entity types for the filter dropdown
const ENTITY_TYPE_OPTIONS = ['slot', 'booking', 'arena', 'venue', 'tenant', 'user', 'pricing_rule'];
const ACTION_OPTIONS = ['create', 'update', 'delete', 'cancel', 'hold', 'release', 'book'];

export default function AuditLogPage() {
  const { activeTenantId } = useOrg();
  const { resolveTz } = useTimezone();

  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat('en-IN', {
        timeZone: resolveTz(),
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }),
    [resolveTz],
  );

  function formatIST(iso: string) {
    return fmt.format(new Date(iso));
  }

  const [actionFilter, setActionFilter]         = useState('');
  const [entityTypeFilter, setEntityTypeFilter] = useState('');
  const [fromFilter, setFromFilter]             = useState('');
  const [toFilter, setToFilter]                 = useState('');

  const params = {
    ...(actionFilter     ? { action:     actionFilter }     : {}),
    ...(entityTypeFilter ? { entityType: entityTypeFilter } : {}),
    ...(fromFilter       ? { from:       new Date(fromFilter).toISOString() } : {}),
    ...(toFilter         ? { to:         new Date(toFilter).toISOString() }   : {}),
  };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
  } = useAuditLog(activeTenantId ?? '', params);

  const allRows: AuditLogItem[] = data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:text-slate-800 transition-colors"
        >
          &larr; Settings
        </Link>
        <h1 className="text-xl font-semibold text-[#0f172a]">Activity Log</h1>
      </div>

      {/* Filters */}
      <Card title="Filters">
        <div className="flex flex-wrap gap-3">
          {/* Action filter */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">Action</label>
            <select
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">All actions</option>
              {ACTION_OPTIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>

          {/* Entity type filter */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">Entity type</label>
            <select
              value={entityTypeFilter}
              onChange={(e) => setEntityTypeFilter(e.target.value)}
              className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">All types</option>
              {ENTITY_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Date from */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">From</label>
            <input
              type="datetime-local"
              value={fromFilter}
              onChange={(e) => setFromFilter(e.target.value)}
              className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          {/* Date to */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">To</label>
            <input
              type="datetime-local"
              value={toFilter}
              onChange={(e) => setToFilter(e.target.value)}
              className="rounded border border-[#e5e7eb] bg-white px-2 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          {/* Clear filters */}
          {(actionFilter || entityTypeFilter || fromFilter || toFilter) && (
            <div className="flex flex-col justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setActionFilter('');
                  setEntityTypeFilter('');
                  setFromFilter('');
                  setToFilter('');
                }}
              >
                Clear
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* Table */}
      <Card title="Activity" subtitle="Audit events for this organization, newest first.">
        {isLoading && (
          <p className="py-6 text-center text-sm text-slate-400">Loading&hellip;</p>
        )}
        {isError && (
          <p className="py-6 text-center text-sm text-red-500">Failed to load activity log.</p>
        )}
        {!isLoading && !isError && allRows.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">No activity found.</p>
        )}
        {!isLoading && !isError && allRows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e5e7eb] text-left">
                  <th className="pb-2 pr-4 font-medium text-slate-500">When</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Actor</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Action</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Entity</th>
                  <th className="pb-2 font-medium text-slate-500">Diff</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {allRows.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {formatIST(row.createdAt)}
                    </td>
                    <td className="py-2.5 pr-4 text-slate-700">
                      {row.actorName ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge tone={actionTone(row.action)} label={row.action} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className="text-slate-700">{row.entityType}</span>
                      {row.entityId && (
                        <Badge
                          tone="neutral"
                          label={row.entityId.slice(0, 8) + '…'}
                          className="ml-1.5 font-mono"
                          title={row.entityId}
                        />
                      )}
                    </td>
                    <td className="py-2.5">
                      <DiffToggle before={row.before} after={row.after} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="secondary"
              size="sm"
              loading={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
