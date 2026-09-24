'use client';

import { formatAmount } from '@/lib/money';
import { Fragment, useMemo, useState } from 'react';
import { useAdminPayouts, useExecutePayout, useReconcilePayouts } from '@/lib/api/queries';
import { ApiError } from '@/lib/api/client';
import type { AdminPayoutRow } from '@/lib/api/types';
import { PayoutBreakdown } from '@/components/PayoutBreakdown';

const STATUS_TONE: Record<AdminPayoutRow['status'], string> = {
  pending: 'bg-amber-100 text-amber-800',
  paid: 'bg-emerald-100 text-emerald-800',
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

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return IST_DATE.format(new Date(iso));
}

type StatusFilter = 'all' | 'pending' | 'paid';
const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'paid', label: 'Paid' },
];

export default function PayoutsPage() {
  const [filter, setFilter] = useState<StatusFilter>('all');

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useAdminPayouts(filter === 'all' ? undefined : filter);

  const execute = useExecutePayout();
  // Which payout has its breakdown open. One at a time: the tables are wide.
  const [openBreakdown, setOpenBreakdown] = useState<string | null>(null);
  const reconcile = useReconcilePayouts();
  const [actionError, setActionError] = useState<string | null>(null);
  const [reconcileResult, setReconcileResult] = useState<string | null>(null);

  function onReconcile() {
    setActionError(null);
    setReconcileResult(null);
    reconcile.mutate(undefined, {
      onSuccess: (res) => {
        setReconcileResult(
          res.inserted > 0
            ? `Reconciliation created ${res.inserted} new payout${res.inserted === 1 ? '' : 's'}.`
            : 'Reconciliation ran — nothing new to settle for the last completed week.',
        );
      },
      onError: (err) => {
        setActionError(err instanceof Error ? err.message : 'Reconciliation failed.');
      },
    });
  }

  const rows: AdminPayoutRow[] = useMemo(
    () => data?.pages.flatMap((p) => p.rows) ?? [],
    [data],
  );

  function onMarkPaid(row: AdminPayoutRow) {
    const reference = window.prompt(
      `Enter the payment reference for the payout to "${row.tenantName}":`,
    );
    if (reference == null) return; // cancelled
    const trimmed = reference.trim();
    if (trimmed === '') {
      setActionError('A reference is required to mark a payout as paid.');
      return;
    }
    setActionError(null);
    execute.mutate(
      { id: row.id, reference: trimmed },
      {
        onError: (err) => {
          if (err instanceof ApiError) {
            if (err.status === 409 || err.code === 'payout_not_pending') {
              setActionError('This payout is no longer pending and cannot be marked paid.');
              return;
            }
            setActionError(err.message);
            return;
          }
          setActionError(err instanceof Error ? err.message : 'unknown error');
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Payouts</h1>
          <p className="text-sm text-slate-500">
            Weekly Circls-as-merchant payouts to venues.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onReconcile}
            disabled={reconcile.isPending}
            title="Recompute payouts for the last completed week (safe to re-run)"
            className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {reconcile.isPending ? 'Reconciling…' : 'Run reconciliation'}
          </button>
          <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5 shadow-sm">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={[
                  'rounded px-3 py-1.5 text-sm font-medium transition-colors',
                  filter === f.id
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900',
                ].join(' ')}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {reconcileResult && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {reconcileResult}
        </div>
      )}

      {actionError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {actionError}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[960px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Venue</th>
              <th className="px-4 py-2 font-medium">Period</th>
              <th className="px-4 py-2 text-right font-medium">Gross</th>
              <th className="px-4 py-2 text-right font-medium">Refunds</th>
              <th className="px-4 py-2 text-right font-medium">Commission</th>
              <th className="px-4 py-2 text-right font-medium">Advances</th>
              <th className="px-4 py-2 text-right font-medium">Net</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Action</th>
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
                  Failed to load: {error instanceof Error ? error.message : 'unknown error'}
                </td>
              </tr>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-400">
                  No payouts found.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <Fragment key={r.id}>
              <tr className="transition-colors hover:bg-slate-50">
                <td className="px-4 py-2.5 font-medium text-slate-900">
                  <button
                    type="button"
                    onClick={() => setOpenBreakdown(openBreakdown === r.id ? null : r.id)}
                    aria-expanded={openBreakdown === r.id}
                    className="text-left text-blue-700 hover:underline"
                  >
                    {r.tenantName}
                  </button>
                  <span className="block text-xs text-slate-400">
                    {openBreakdown === r.id ? 'Hide what this is for' : 'What is this for?'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-500">
                  {fmtDate(r.periodStart)} → {fmtDate(r.periodEnd)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {formatAmount(r.grossPaise)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {formatAmount(r.refundsPaise)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {formatAmount(r.commissionPaise)}
                </td>
                <td
                  className="px-4 py-2.5 text-right tabular-nums text-slate-700"
                  title={
                    r.advanceRecoupedPaise
                      ? `Recouped from earlier advances: ${formatAmount(r.advanceRecoupedPaise)}`
                      : undefined
                  }
                >
                  {r.advancesPaise || r.advanceRecoupedPaise
                    ? `${formatAmount(r.advancesPaise)}${r.advanceRecoupedPaise ? ` (−${formatAmount(r.advanceRecoupedPaise)})` : ''}`
                    : '—'}
                </td>
                <td className="px-4 py-2.5 text-right font-medium tabular-nums text-slate-900">
                  {formatAmount(r.amountPaise)}
                </td>
                <td className="px-4 py-2.5">
                  <Pill tone={STATUS_TONE[r.status] ?? 'bg-slate-100 text-slate-600'} label={r.status} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  {r.status === 'pending' ? (
                    <button
                      type="button"
                      onClick={() => onMarkPaid(r)}
                      disabled={execute.isPending}
                      className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {execute.isPending ? 'Working…' : 'Mark paid'}
                    </button>
                  ) : (
                    <span className="text-xs text-slate-400">
                      {r.paidReference ?? '—'}
                    </span>
                  )}
                </td>
              </tr>
              {openBreakdown === r.id && (
                <tr>
                  <td colSpan={9} className="p-0">
                    <PayoutBreakdown payoutId={r.id} />
                  </td>
                </tr>
              )}
              </Fragment>
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
