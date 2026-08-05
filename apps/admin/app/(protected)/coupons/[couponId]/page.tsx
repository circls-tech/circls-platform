'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import {
  useAdminCoupons,
  useAdminCouponStats,
  useUpdateAdminCoupon,
  useDeleteAdminCoupon,
  type AdminUpdateCouponPatch,
} from '@/lib/api/queries';
import type { Coupon } from '@/lib/api/types';

const inputCls = 'mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm';
const labelCls = 'block text-sm font-medium text-slate-700';
const STATUS_TONE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  paused: 'bg-amber-100 text-amber-800',
  expired: 'bg-rose-100 text-rose-800',
};

function rupees(paise: number) {
  return `₹${(paise / 100).toFixed(2)}`;
}
function discountLabel(c: Coupon) {
  return c.discountType === 'percent' ? `${c.discountValue / 100}%` : rupees(c.discountValue);
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

/** datetime-local inputs hold local wall time — seed them from the ISO string
 *  via local getters, not a UTC substring, or each save shifts by the offset. */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-sm text-slate-700">{children}</dd>
    </div>
  );
}

export default function AdminCouponDetailPage() {
  const { couponId } = useParams<{ couponId: string }>();
  const router = useRouter();
  const { data: coupons, isLoading } = useAdminCoupons();
  const coupon = coupons?.find((c) => c.id === couponId);
  const { data: stats } = useAdminCouponStats();
  const couponStats = stats?.byCoupon.find((s) => s.couponId === couponId);
  const update = useUpdateAdminCoupon();
  const del = useDeleteAdminCoupon();

  const [editing, setEditing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [maxDiscountRupees, setMaxDiscountRupees] = useState('');
  const [minOrderRupees, setMinOrderRupees] = useState('');
  const [validFromLocal, setValidFromLocal] = useState('');
  const [validUntilLocal, setValidUntilLocal] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [perUserLimit, setPerUserLimit] = useState('');

  function reportError(e: unknown) {
    setErrorMsg(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Unknown error');
  }

  function startEdit() {
    if (!coupon) return;
    setDescription(coupon.description ?? '');
    setVisibility(coupon.visibility);
    setMaxDiscountRupees(coupon.maxDiscountPaise != null ? String(coupon.maxDiscountPaise / 100) : '');
    setMinOrderRupees(coupon.minOrderPaise != null ? String(coupon.minOrderPaise / 100) : '');
    setValidFromLocal(coupon.validFrom ? isoToLocalInput(coupon.validFrom) : '');
    setValidUntilLocal(coupon.validUntil ? isoToLocalInput(coupon.validUntil) : '');
    setMaxRedemptions(coupon.maxRedemptions != null ? String(coupon.maxRedemptions) : '');
    setPerUserLimit(coupon.perUserLimit != null ? String(coupon.perUserLimit) : '');
    setErrorMsg(null);
    setEditing(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    // Zero/empty/garbage in a money or limit field means "no constraint" → null
    // (the API rejects non-positive numbers).
    const maxDiscountNum = parseFloat(maxDiscountRupees);
    const minOrderNum = parseFloat(minOrderRupees);
    const maxRedemptionsNum = parseInt(maxRedemptions, 10);
    const perUserLimitNum = parseInt(perUserLimit, 10);
    const patch: AdminUpdateCouponPatch = {
      description: description || null,
      visibility,
      maxDiscountPaise: maxDiscountNum > 0 ? Math.round(maxDiscountNum * 100) : null,
      minOrderPaise: minOrderNum > 0 ? Math.round(minOrderNum * 100) : null,
      validFrom: validFromLocal ? new Date(validFromLocal).toISOString() : null,
      validUntil: validUntilLocal ? new Date(validUntilLocal).toISOString() : null,
      maxRedemptions: maxRedemptionsNum > 0 ? maxRedemptionsNum : null,
      perUserLimit: perUserLimitNum > 0 ? perUserLimitNum : null,
    };
    try {
      await update.mutateAsync({ id: couponId, patch });
      setEditing(false);
    } catch (e) { reportError(e); }
  }

  async function setStatus(status: 'active' | 'paused') {
    setErrorMsg(null);
    try { await update.mutateAsync({ id: couponId, patch: { status } }); }
    catch (e) { reportError(e); }
  }

  async function onDelete() {
    if (!coupon || !confirm(`Delete platform coupon "${coupon.code}"? This cannot be undone.`)) return;
    setErrorMsg(null);
    try { await del.mutateAsync(couponId); router.push('/coupons'); }
    catch (e) { reportError(e); }
  }

  return (
    <div className="space-y-4">
      <Link href="/coupons" className="text-sm text-slate-500 hover:text-slate-800">&larr; Coupons</Link>
      {isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {!isLoading && !coupon && <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">Coupon not found.</p>}
      {errorMsg && <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{errorMsg}</p>}

      {coupon && (
        <>
          <div className="flex items-center justify-between gap-3">
            <h1 className="font-mono text-2xl font-semibold text-slate-900">{coupon.code}</h1>
            <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[coupon.status] ?? 'bg-slate-100 text-slate-600'}`}>{coupon.status}</span>
          </div>

          {!editing && (
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <dl className="grid grid-cols-1 gap-y-4 sm:grid-cols-2">
                <Field label="Scope">{coupon.scopeType === 'org' ? 'Platform-wide' : `${coupon.scopeType} (${coupon.scopeId})`}</Field>
                <Field label="Discount">{discountLabel(coupon)}{coupon.maxDiscountPaise != null ? ` (max ${rupees(coupon.maxDiscountPaise)})` : ''}</Field>
                <Field label="Visibility"><span className="capitalize">{coupon.visibility}</span></Field>
                <Field label="Min order">{coupon.minOrderPaise != null ? rupees(coupon.minOrderPaise) : '—'}</Field>
                <Field label="Redeemed">{coupon.maxRedemptions ? `${coupon.redeemedCount}/${coupon.maxRedemptions}` : `${coupon.redeemedCount}/∞`}{coupon.perUserLimit ? ` · ${coupon.perUserLimit}/user` : ''}</Field>
                <Field label="Valid">{coupon.validFrom ? formatDate(coupon.validFrom) : 'Always'} → {coupon.validUntil ? formatDate(coupon.validUntil) : 'No expiry'}</Field>
                <Field label="Created">{formatDate(coupon.createdAt)}</Field>
                <Field label="Discount spent">{couponStats ? `${rupees(couponStats.discountPaise)} across ${couponStats.redemptions} redemption${couponStats.redemptions === 1 ? '' : 's'}` : 'No redemptions yet.'}</Field>
                {coupon.description && <div className="sm:col-span-2"><Field label="Description">{coupon.description}</Field></div>}
              </dl>
              <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
                <button type="button" onClick={startEdit} className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100">Edit</button>
                {coupon.status === 'active' && <button type="button" disabled={update.isPending} onClick={() => setStatus('paused')} className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50">Pause</button>}
                {coupon.status === 'paused' && <button type="button" disabled={update.isPending} onClick={() => setStatus('active')} className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50">Resume</button>}
                <button type="button" disabled={del.isPending} onClick={onDelete} className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50">Delete</button>
              </div>
            </div>
          )}

          {editing && (
            <form onSubmit={onSubmit} className="grid max-w-2xl grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2">
              <p className="text-xs text-slate-500 sm:col-span-2">Code, scope, and discount type/amount can&apos;t be changed after creation. Create a new coupon to change those.</p>
              <label className={`${labelCls} sm:col-span-2`}>Description
                <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
              </label>
              <label className={labelCls}>Visibility
                <select className={inputCls} value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}>
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </label>
              {coupon.discountType === 'percent' ? (
                <label className={labelCls}>Max discount (₹)
                  <input className={inputCls} type="number" min={0} value={maxDiscountRupees} onChange={(e) => setMaxDiscountRupees(e.target.value)} />
                </label>
              ) : (
                <div className="hidden sm:block" />
              )}
              <label className={labelCls}>Minimum order (₹)
                <input className={inputCls} type="number" min={0} value={minOrderRupees} onChange={(e) => setMinOrderRupees(e.target.value)} />
              </label>
              <div className="hidden sm:block" />
              <label className={labelCls}>Valid from
                <input className={inputCls} type="datetime-local" value={validFromLocal} onChange={(e) => setValidFromLocal(e.target.value)} />
              </label>
              <label className={labelCls}>Valid until
                <input className={inputCls} type="datetime-local" value={validUntilLocal} onChange={(e) => setValidUntilLocal(e.target.value)} />
              </label>
              <label className={labelCls}>Total max redemptions
                <input className={inputCls} type="number" min={1} value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} />
              </label>
              <label className={labelCls}>Per-user limit
                <input className={inputCls} type="number" min={1} value={perUserLimit} onChange={(e) => setPerUserLimit(e.target.value)} />
              </label>
              <div className="flex justify-end gap-2 sm:col-span-2">
                <button type="button" onClick={() => setEditing(false)} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
                <button type="submit" disabled={update.isPending} className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
                  {update.isPending ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
