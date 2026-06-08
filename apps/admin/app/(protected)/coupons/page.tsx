'use client';

import { type FormEvent, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import {
  useAdminCoupons,
  useCreateAdminCoupon,
  useUpdateAdminCoupon,
  useDeleteAdminCoupon,
  type AdminCreateCouponBody,
} from '@/lib/api/queries';
import type { Coupon } from '@/lib/api/types';

const STATUS_TONE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-amber-100 text-amber-800',
  expired: 'bg-rose-100 text-rose-800',
};
const inputCls = 'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm';

function discountLabel(c: Coupon) {
  return c.discountType === 'percent' ? `${c.discountValue / 100}%` : `₹${(c.discountValue / 100).toFixed(2)}`;
}

export default function AdminCouponsPage() {
  const { data: coupons, isLoading, isError, error } = useAdminCoupons();
  const create = useCreateAdminCoupon();
  const update = useUpdateAdminCoupon();
  const del = useDeleteAdminCoupon();
  const [showForm, setShowForm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [code, setCode] = useState('');
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>('percent');
  const [discountValue, setDiscountValue] = useState('');
  const [scopeType, setScopeType] = useState<AdminCreateCouponBody['scopeType']>('org');
  const [scopeId, setScopeId] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [validUntilLocal, setValidUntilLocal] = useState('');

  function reportError(err: unknown) {
    setActionError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Unknown error');
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setActionError(null);
    const num = parseFloat(discountValue || '0');
    if (!code.trim() || !(num > 0)) return setActionError('Code and a positive discount are required.');
    if (scopeType !== 'org' && !scopeId.trim()) return setActionError('Non-org scope needs a target id.');
    const body: AdminCreateCouponBody = {
      code: code.trim().toUpperCase(),
      scopeType,
      discountType,
      discountValue: Math.round(num * 100),
      visibility,
      ...(scopeType !== 'org' && scopeId.trim() ? { scopeId: scopeId.trim() } : {}),
      ...(validUntilLocal ? { validUntil: new Date(validUntilLocal).toISOString() } : {}),
    };
    try {
      await create.mutateAsync(body);
      setShowForm(false);
      setCode(''); setDiscountValue(''); setScopeId(''); setValidUntilLocal('');
    } catch (err) { reportError(err); }
  }

  async function toggle(c: Coupon) {
    setActionError(null);
    try { await update.mutateAsync({ id: c.id, patch: { status: c.status === 'active' ? 'paused' : 'active' } }); }
    catch (err) { reportError(err); }
  }
  async function onDelete(c: Coupon) {
    if (!confirm(`Delete platform coupon "${c.code}"?`)) return;
    setActionError(null);
    try { await del.mutateAsync(c.id); } catch (err) { reportError(err); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Coupons</h1>
          <p className="text-sm text-slate-500">Platform-wide, Circls-funded promotional coupons.</p>
        </div>
        <button type="button" onClick={() => setShowForm((s) => !s)} className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800">
          {showForm ? 'Close' : 'New coupon'}
        </button>
      </div>

      {actionError && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{actionError}</div>}

      {showForm && (
        <form onSubmit={onCreate} className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2">
          <label className="text-sm">Code<input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder="DIWALI20" /></label>
          <label className="text-sm">Discount type
            <select className={inputCls} value={discountType} onChange={(e) => setDiscountType(e.target.value as 'percent' | 'fixed')}>
              <option value="percent">Percentage (%)</option>
              <option value="fixed">Fixed (₹)</option>
            </select>
          </label>
          <label className="text-sm">{discountType === 'percent' ? 'Discount (%)' : 'Discount (₹)'}<input className={inputCls} type="number" min={0} value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} /></label>
          <label className="text-sm">Scope
            <select className={inputCls} value={scopeType} onChange={(e) => setScopeType(e.target.value as AdminCreateCouponBody['scopeType'])}>
              <option value="org">Platform-wide</option>
              <option value="venue">Venue (id)</option>
              <option value="event">Event (id)</option>
              <option value="arena">Arena (id)</option>
              <option value="membership">Membership (id)</option>
            </select>
          </label>
          {scopeType !== 'org' && <label className="text-sm">Target id (UUID)<input className={inputCls} value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder="UUID" /></label>}
          <label className="text-sm">Visibility
            <select className={inputCls} value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}>
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </label>
          <label className="text-sm">Valid until (optional)<input className={inputCls} type="datetime-local" value={validUntilLocal} onChange={(e) => setValidUntilLocal(e.target.value)} /></label>
          <div className="sm:col-span-2 flex justify-end">
            <button type="submit" disabled={create.isPending} className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
              {create.isPending ? 'Creating…' : 'Create coupon'}
            </button>
          </div>
        </form>
      )}

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
                <td className="px-4 py-2.5 font-mono text-xs font-medium text-slate-900">{c.code}</td>
                <td className="px-4 py-2.5 text-xs text-slate-600">{c.scopeType === 'org' ? 'Platform-wide' : c.scopeType}</td>
                <td className="px-4 py-2.5 text-xs text-slate-700">{discountLabel(c)}</td>
                <td className="px-4 py-2.5 text-xs capitalize text-slate-600">{c.visibility}</td>
                <td className="px-4 py-2.5 text-right text-xs text-slate-600">{c.maxRedemptions ? `${c.redeemedCount}/${c.maxRedemptions}` : c.redeemedCount}</td>
                <td className="px-4 py-2.5"><span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[c.status] ?? 'bg-slate-100 text-slate-600'}`}>{c.status}</span></td>
                <td className="px-4 py-2.5 text-right space-x-2">
                  {c.status !== 'expired' && (
                    <button type="button" onClick={() => toggle(c)} disabled={update.isPending} className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">
                      {c.status === 'active' ? 'Pause' : 'Resume'}
                    </button>
                  )}
                  <button type="button" onClick={() => onDelete(c)} disabled={del.isPending} className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
