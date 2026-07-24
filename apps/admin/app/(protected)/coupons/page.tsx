'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ApiError } from '@/lib/api/client';
import { useAdminCoupons, useUpdateAdminCoupon } from '@/lib/api/queries';
import type { Coupon } from '@/lib/api/types';

const STATUS_TONE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-amber-100 text-amber-800',
  expired: 'bg-rose-100 text-rose-800',
};

function discountLabel(c: Coupon) {
  return c.discountType === 'percent' ? `${c.discountValue / 100}%` : `₹${(c.discountValue / 100).toFixed(2)}`;
}

export default function AdminCouponsPage() {
  const { data: coupons, isLoading, isError, error } = useAdminCoupons();
  const update = useUpdateAdminCoupon();
  const [actionError, setActionError] = useState<string | null>(null);

  async function toggle(c: Coupon) {
    setActionError(null);
    try { await update.mutateAsync({ id: c.id, patch: { status: c.status === 'active' ? 'paused' : 'active' } }); }
    catch (err) { setActionError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Unknown error'); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Coupons</h1>
          <p className="text-sm text-slate-500">Platform-wide, Circls-funded promotional coupons.</p>
        </div>
        <Link href="/coupons/new" className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
          New coupon
        </Link>
      </div>

      {actionError && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{actionError}</div>}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Code</th>
              <th className="px-4 py-2 font-medium">Scope</th>
              <th className="px-4 py-2 font-medium">Discount</th>
              <th className="px-4 py-2 font-medium">Visibility</th>
              <th className="px-4 py-2 text-right font-medium">Redeemed</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">Loading…</td></tr>}
            {isError && <tr><td colSpan={7} className="px-4 py-8 text-center text-red-600">{error instanceof Error ? error.message : 'Failed to load'}</td></tr>}
            {!isLoading && !isError && (coupons?.length ?? 0) === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No platform coupons.</td></tr>}
            {coupons?.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className="px-4 py-2.5 font-mono text-xs font-medium">
                  <Link href={`/coupons/${c.id}`} className="text-blue-600 hover:text-blue-800 hover:underline">{c.code}</Link>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-600">{c.scopeType === 'org' ? 'Platform-wide' : c.scopeType}</td>
                <td className="px-4 py-2.5 text-xs text-slate-700">{discountLabel(c)}</td>
                <td className="px-4 py-2.5 text-xs capitalize text-slate-600">{c.visibility}</td>
                <td className="px-4 py-2.5 text-right text-xs text-slate-600">{c.maxRedemptions ? `${c.redeemedCount}/${c.maxRedemptions}` : c.redeemedCount}</td>
                <td className="px-4 py-2.5"><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[c.status] ?? 'bg-slate-100 text-slate-600'}`}>{c.status}</span></td>
                <td className="px-4 py-2.5 text-right">
                  {c.status !== 'expired' && (
                    <button type="button" onClick={() => toggle(c)} disabled={update.isPending} className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">
                      {c.status === 'active' ? 'Pause' : 'Resume'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
