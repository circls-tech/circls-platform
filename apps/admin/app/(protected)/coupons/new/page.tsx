'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import { useAdminListings, useCreateAdminCoupon, type AdminCreateCouponBody } from '@/lib/api/queries';
import type { AdminListingType } from '@/lib/api/types';

const inputCls = 'mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm';
const labelCls = 'block text-sm font-medium text-slate-700';

type ScopeType = AdminCreateCouponBody['scopeType'];

/** The "live" listing status per type — pickers only offer things consumers can buy. */
const LIVE_STATUS: Record<Exclude<ScopeType, 'org'>, string> = {
  venue: 'active',
  arena: 'active',
  event: 'published',
  membership: 'active',
};

export default function NewAdminCouponPage() {
  const router = useRouter();
  const create = useCreateAdminCoupon();

  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [scopeType, setScopeType] = useState<ScopeType>('org');
  const [scopeId, setScopeId] = useState('');
  const [manualScopeId, setManualScopeId] = useState('');
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>('percent');
  const [discountValue, setDiscountValue] = useState('');
  const [maxDiscountRupees, setMaxDiscountRupees] = useState('');
  const [minOrderRupees, setMinOrderRupees] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('private');
  const [validFromLocal, setValidFromLocal] = useState('');
  const [validUntilLocal, setValidUntilLocal] = useState('');
  const [maxRedemptions, setMaxRedemptions] = useState('');
  const [perUserLimit, setPerUserLimit] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const listingType: AdminListingType | null = scopeType === 'org' ? null : scopeType;
  const { data: listings, isLoading: listingsLoading } = useAdminListings(
    listingType,
    listingType ? LIVE_STATUS[listingType] : undefined,
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!code.trim()) return setErr('Enter a coupon code.');
    const num = parseFloat(discountValue || '0');
    if (!(num > 0)) return setErr('Enter a positive discount.');
    const discountValueConv = Math.round(num * 100); // bps for percent, paise for fixed
    if (discountType === 'percent' && (discountValueConv < 1 || discountValueConv > 10000)) {
      return setErr('Percent discount must be between 0.01% and 100%.');
    }
    const targetId = (manualScopeId.trim() || scopeId).trim();
    if (scopeType !== 'org' && !targetId) return setErr('Pick the target for this scope.');

    // Zero/empty/garbage in an optional money or limit field means "no
    // constraint" → omit (the API rejects non-positive numbers).
    const maxDiscountNum = parseFloat(maxDiscountRupees);
    const minOrderNum = parseFloat(minOrderRupees);
    const maxRedemptionsNum = parseInt(maxRedemptions, 10);
    const perUserLimitNum = parseInt(perUserLimit, 10);
    const body: AdminCreateCouponBody = {
      code: code.trim().toUpperCase(),
      scopeType,
      discountType,
      discountValue: discountValueConv,
      visibility,
      ...(description ? { description } : {}),
      ...(scopeType !== 'org' ? { scopeId: targetId } : {}),
      ...(discountType === 'percent' && maxDiscountNum > 0 ? { maxDiscountPaise: Math.round(maxDiscountNum * 100) } : {}),
      ...(minOrderNum > 0 ? { minOrderPaise: Math.round(minOrderNum * 100) } : {}),
      ...(validFromLocal ? { validFrom: new Date(validFromLocal).toISOString() } : {}),
      ...(validUntilLocal ? { validUntil: new Date(validUntilLocal).toISOString() } : {}),
      ...(maxRedemptionsNum > 0 ? { maxRedemptions: maxRedemptionsNum } : {}),
      ...(perUserLimitNum > 0 ? { perUserLimit: perUserLimitNum } : {}),
    };
    try {
      await create.mutateAsync(body);
      router.push('/coupons');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : (e as Error).message);
    }
  }

  return (
    <div className="space-y-4">
      <Link href="/coupons" className="text-sm text-slate-500 hover:text-slate-800">&larr; Coupons</Link>
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New platform coupon</h1>
        <p className="text-sm text-slate-500">Circls-funded — partner payouts are unaffected. Money amounts are in ₹.</p>
      </div>

      <form onSubmit={onSubmit} className="grid max-w-2xl grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2">
        <label className={labelCls}>Code
          <input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder="DIWALI20" />
          <span className="mt-1 block text-xs font-normal text-slate-400">Stored uppercase. Unique across the platform.</span>
        </label>
        <label className={labelCls}>Description (optional)
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Festive 20% off, platform-wide" />
        </label>

        <label className={labelCls}>Scope
          <select className={inputCls} value={scopeType} onChange={(e) => { setScopeType(e.target.value as ScopeType); setScopeId(''); setManualScopeId(''); }}>
            <option value="org">Platform-wide</option>
            <option value="venue">A venue</option>
            <option value="event">A specific event</option>
            <option value="arena">A specific arena</option>
            <option value="membership">A specific membership</option>
          </select>
        </label>
        {scopeType !== 'org' && (
          <label className={labelCls}>Target
            <select className={inputCls} value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
              <option value="">{listingsLoading ? 'Loading…' : `Select a ${scopeType}…`}</option>
              {listings?.rows.map((r) => (
                <option key={r.id} value={r.id}>{r.name} — {r.tenantName}</option>
              ))}
            </select>
            <input className={inputCls} value={manualScopeId} onChange={(e) => setManualScopeId(e.target.value)} placeholder="…or paste the exact id (UUID)" />
          </label>
        )}

        <label className={labelCls}>Discount type
          <select className={inputCls} value={discountType} onChange={(e) => setDiscountType(e.target.value as 'percent' | 'fixed')}>
            <option value="percent">Percentage (%)</option>
            <option value="fixed">Fixed (₹)</option>
          </select>
        </label>
        <label className={labelCls}>{discountType === 'percent' ? 'Discount (%)' : 'Discount (₹)'}
          <input className={inputCls} type="number" min={0} step={discountType === 'percent' ? 0.01 : 1} value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} />
        </label>
        {discountType === 'percent' && (
          <label className={labelCls}>Max discount (₹, optional)
            <input className={inputCls} type="number" min={0} step={1} value={maxDiscountRupees} onChange={(e) => setMaxDiscountRupees(e.target.value)} />
            <span className="mt-1 block text-xs font-normal text-slate-400">Cap on a percentage discount.</span>
          </label>
        )}
        <label className={labelCls}>Minimum order (₹, optional)
          <input className={inputCls} type="number" min={0} step={1} value={minOrderRupees} onChange={(e) => setMinOrderRupees(e.target.value)} />
        </label>

        <label className={labelCls}>Visibility
          <select className={inputCls} value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}>
            <option value="private">Private — customers must type the code</option>
            <option value="public">Public — shown on the item's page and in checkout offers</option>
          </select>
        </label>
        <div className="hidden sm:block" />

        <label className={labelCls}>Valid from (optional)
          <input className={inputCls} type="datetime-local" value={validFromLocal} onChange={(e) => setValidFromLocal(e.target.value)} />
        </label>
        <label className={labelCls}>Valid until (optional)
          <input className={inputCls} type="datetime-local" value={validUntilLocal} onChange={(e) => setValidUntilLocal(e.target.value)} />
        </label>
        <label className={labelCls}>Total max redemptions (optional)
          <input className={inputCls} type="number" min={1} value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} />
        </label>
        <label className={labelCls}>Per-user limit (optional)
          <input className={inputCls} type="number" min={1} value={perUserLimit} onChange={(e) => setPerUserLimit(e.target.value)} />
        </label>

        {err && <p className="text-sm text-red-600 sm:col-span-2">{err}</p>}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <button type="button" onClick={() => router.push('/coupons')} className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={create.isPending} className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
            {create.isPending ? 'Creating…' : 'Create coupon'}
          </button>
        </div>
      </form>
    </div>
  );
}
