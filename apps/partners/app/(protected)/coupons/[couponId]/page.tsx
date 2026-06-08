'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useTenantCoupons, useUpdateCoupon, useDeleteCoupon, type Coupon, type UpdateCouponPatch } from '@/lib/api/coupons';
import { Button, Card, Input, StatusPill } from '@/lib/ui';

const selectCls = 'w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a]';
const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

function discountLabel(c: Coupon) {
  return c.discountType === 'percent' ? `${c.discountValue / 100}%` : `₹${(c.discountValue / 100).toFixed(2)}`;
}

export default function CouponDetailPage() {
  const { couponId } = useParams<{ couponId: string }>();
  const router = useRouter();
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const { data: coupons, isLoading } = useTenantCoupons(tenantId);
  const coupon = coupons?.find((c) => c.id === couponId);
  const update = useUpdateCoupon(tenantId);
  const del = useDeleteCoupon(tenantId);

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

  function startEdit() {
    if (!coupon) return;
    setDescription(coupon.description ?? '');
    setVisibility(coupon.visibility);
    setMaxDiscountRupees(coupon.maxDiscountPaise != null ? String(coupon.maxDiscountPaise / 100) : '');
    setMinOrderRupees(coupon.minOrderPaise != null ? String(coupon.minOrderPaise / 100) : '');
    setValidFromLocal(coupon.validFrom ? coupon.validFrom.substring(0, 16) : '');
    setValidUntilLocal(coupon.validUntil ? coupon.validUntil.substring(0, 16) : '');
    setMaxRedemptions(coupon.maxRedemptions != null ? String(coupon.maxRedemptions) : '');
    setPerUserLimit(coupon.perUserLimit != null ? String(coupon.perUserLimit) : '');
    setErrorMsg(null);
    setEditing(true);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    const patch: UpdateCouponPatch = {
      description: description || null,
      visibility,
      maxDiscountPaise: maxDiscountRupees ? Math.round(parseFloat(maxDiscountRupees) * 100) : null,
      minOrderPaise: minOrderRupees ? Math.round(parseFloat(minOrderRupees) * 100) : null,
      validFrom: validFromLocal ? new Date(validFromLocal).toISOString() : null,
      validUntil: validUntilLocal ? new Date(validUntilLocal).toISOString() : null,
      maxRedemptions: maxRedemptions ? parseInt(maxRedemptions, 10) : null,
      perUserLimit: perUserLimit ? parseInt(perUserLimit, 10) : null,
    };
    try {
      await update.mutateAsync({ couponId, patch });
      setEditing(false);
    } catch (e) { setErrorMsg((e as Error).message); }
  }

  async function setStatus(status: 'active' | 'paused') {
    setErrorMsg(null);
    try { await update.mutateAsync({ couponId, patch: { status } }); }
    catch (e) { setErrorMsg((e as Error).message); }
  }

  async function onDelete() {
    if (!coupon || !confirm(`Delete coupon "${coupon.code}"? This cannot be undone.`)) return;
    setErrorMsg(null);
    try { await del.mutateAsync(couponId); router.push('/coupons'); }
    catch (e) { setErrorMsg((e as Error).message); }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/coupons" className="text-sm text-slate-500 hover:text-slate-800">&larr; Coupons</Link>
      {isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {!isLoading && !coupon && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">Coupon not found.</p>}
      {errorMsg && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{errorMsg}</p>}

      {coupon && (
        <>
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold text-[#0f172a]">{coupon.code}</h1>
            <StatusPill status={coupon.status} />
          </div>

          {!editing && (
            <Card title="Details">
              <dl className="grid grid-cols-1 gap-y-4 sm:grid-cols-2">
                <div><dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">Scope</dt><dd className="mt-1 text-sm text-slate-700">{coupon.scopeType === 'org' ? 'Org-wide' : `${coupon.scopeType} (${coupon.scopeId})`}</dd></div>
                <div><dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">Discount</dt><dd className="mt-1 text-sm text-slate-700">{discountLabel(coupon)}{coupon.maxDiscountPaise != null ? ` (max ₹${(coupon.maxDiscountPaise / 100).toFixed(2)})` : ''}</dd></div>
                <div><dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">Visibility</dt><dd className="mt-1 text-sm capitalize text-slate-700">{coupon.visibility}</dd></div>
                <div><dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">Min order</dt><dd className="mt-1 text-sm text-slate-700">{coupon.minOrderPaise != null ? `₹${(coupon.minOrderPaise / 100).toFixed(2)}` : '—'}</dd></div>
                <div><dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">Redeemed</dt><dd className="mt-1 text-sm text-slate-700">{coupon.maxRedemptions ? `${coupon.redeemedCount}/${coupon.maxRedemptions}` : `${coupon.redeemedCount}/∞`}{coupon.perUserLimit ? ` · ${coupon.perUserLimit}/user` : ''}</dd></div>
                <div><dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">Valid</dt><dd className="mt-1 text-sm text-slate-700">{coupon.validFrom ? IST.format(new Date(coupon.validFrom)) : 'Always'} → {coupon.validUntil ? IST.format(new Date(coupon.validUntil)) : 'No expiry'}</dd></div>
                {coupon.description && <div className="sm:col-span-2"><dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">Description</dt><dd className="mt-1 text-sm text-slate-700">{coupon.description}</dd></div>}
              </dl>
              <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-[#f1f5f9] pt-4">
                <Button variant="secondary" size="sm" onClick={startEdit}>Edit</Button>
                {coupon.status === 'active' && <Button variant="secondary" size="sm" loading={update.isPending} onClick={() => setStatus('paused')}>Pause</Button>}
                {coupon.status === 'paused' && <Button size="sm" loading={update.isPending} onClick={() => setStatus('active')}>Resume</Button>}
                <Button variant="danger" size="sm" loading={del.isPending} onClick={onDelete}>Delete</Button>
              </div>
            </Card>
          )}

          {editing && (
            <Card title="Edit coupon">
              <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
                <p className="text-xs text-slate-500">Code, scope, and discount type/amount can&apos;t be changed after creation. Create a new coupon to change those.</p>
                <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
                <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Visibility</label>
                <select className={selectCls} value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}>
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
                {coupon.discountType === 'percent' && <Input label="Max discount (₹)" type="number" min={0} value={maxDiscountRupees} onChange={(e) => setMaxDiscountRupees(e.target.value)} />}
                <Input label="Minimum order (₹)" type="number" min={0} value={minOrderRupees} onChange={(e) => setMinOrderRupees(e.target.value)} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Input label="Valid from" type="datetime-local" value={validFromLocal} onChange={(e) => setValidFromLocal(e.target.value)} />
                  <Input label="Valid until" type="datetime-local" value={validUntilLocal} onChange={(e) => setValidUntilLocal(e.target.value)} />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Input label="Total max redemptions" type="number" min={1} value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} />
                  <Input label="Per-user limit" type="number" min={1} value={perUserLimit} onChange={(e) => setPerUserLimit(e.target.value)} />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
                  <Button type="submit" loading={update.isPending}>Save changes</Button>
                </div>
              </form>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
