'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useAdminAuditLog, type AdminAuditLogFilters } from '@/lib/api/queries';
import type { AdminAuditLogItem } from '@/lib/api/types';

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

function isUuidOrEmpty(s: string): boolean {
  if (s === '') return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export default function AuditLogPage() {
  // Form state — strings the user types
  const [tenantId, setTenantId] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [action, setAction] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  // Applied filters — what we actually send. Only update on "Apply".
  const [applied, setApplied] = useState<AdminAuditLogFilters>({});

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useAdminAuditLog(applied);

  const rows: AdminAuditLogItem[] = useMemo(
    () => data?.pages.flatMap((p) => p.rows) ?? [],
    [data],
  );

  const tenantIdInvalid = !isUuidOrEmpty(tenantId);
  const actorInvalid = !isUuidOrEmpty(actorUserId);
  const entityIdInvalid = !isUuidOrEmpty(entityId);
  const formInvalid = tenantIdInvalid || actorInvalid || entityIdInvalid;

  function apply() {
    if (formInvalid) return;
    const next: AdminAuditLogFilters = {};
    if (tenantId.trim())    next.tenantId    = tenantId.trim();
    if (actorUserId.trim()) next.actorUserId = actorUserId.trim();
    if (entityType.trim())  next.entityType  = entityType.trim();
    if (entityId.trim())    next.entityId    = entityId.trim();
    if (action.trim())      next.action      = action.trim();
    if (since)              next.since       = new Date(since).toISOString();
    if (until)              next.until       = new Date(until).toISOString();
    setApplied(next);
  }

  function clearAll() {
    setTenantId('');
    setActorUserId('');
    setEntityType('');
    setEntityId('');
    setAction('');
    setSince('');
    setUntil('');
    setApplied({});
  }

  const hasAnyApplied = Object.keys(applied).length > 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Audit log search</h1>
        <p className="text-sm text-slate-500">
          Cross-tenant search of every audit event. Use UUIDs for tenant / actor / entity filters.
        </p>
      </div>

      {/* Filters */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Tenant ID" invalid={tenantIdInvalid}>
            <input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="UUID"
              className={inputCls(tenantIdInvalid)}
            />
          </Field>
          <Field label="Actor user ID" invalid={actorInvalid}>
            <input
              value={actorUserId}
              onChange={(e) => setActorUserId(e.target.value)}
              placeholder="UUID"
              className={inputCls(actorInvalid)}
            />
          </Field>
          <Field label="Entity type">
            <input
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              placeholder="slot, booking, tenant…"
              className={inputCls(false)}
            />
          </Field>
          <Field label="Entity ID" invalid={entityIdInvalid}>
            <input
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
              placeholder="UUID"
              className={inputCls(entityIdInvalid)}
            />
          </Field>
          <Field label="Action">
            <input
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="e.g. booking.create"
              className={inputCls(false)}
            />
          </Field>
          <Field label="Since">
            <input
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className={inputCls(false)}
            />
          </Field>
          <Field label="Until">
            <input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className={inputCls(false)}
            />
          </Field>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={apply}
              disabled={formInvalid}
              className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Apply
            </button>
            {hasAnyApplied && (
              <button
                type="button"
                onClick={clearAll}
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">When (IST)</th>
              <th className="px-4 py-2 font-medium">Tenant</th>
              <th className="px-4 py-2 font-medium">Actor</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Entity</th>
              <th className="px-4 py-2 font-medium">Diff</th>
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
                  No audit events match these filters.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-4 py-2.5 whitespace-nowrap font-mono text-xs text-slate-500">
                  {IST_FMT.format(new Date(r.createdAt))}
                </td>
                <td className="px-4 py-2.5 font-mono text-xs">
                  {r.tenantId ? (
                    <Link
                      href={`/tenants/${r.tenantId}`}
                      className="text-blue-700 hover:underline"
                    >
                      {r.tenantId.slice(0, 8)}…
                    </Link>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
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

function inputCls(invalid: boolean): string {
  return [
    'w-full rounded-md border bg-white px-2.5 py-1.5 text-sm text-slate-700 shadow-sm focus:outline-none',
    invalid
      ? 'border-rose-300 focus:border-rose-400'
      : 'border-slate-200 focus:border-slate-400',
  ].join(' ');
}

function Field({
  label,
  invalid,
  children,
}: {
  label: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-slate-500">
        {label}
        {invalid && <span className="ml-1 text-rose-600">(invalid)</span>}
      </span>
      {children}
    </label>
  );
}
