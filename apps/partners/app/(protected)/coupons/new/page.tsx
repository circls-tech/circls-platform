'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useCreateCoupon, type CreateCouponInput, type CouponScopeType } from '@/lib/api/coupons';
import { useVenues, useArenas } from '@/lib/api/queries';
import { useTenantEvents } from '@/lib/api/events';
import { useMemberships } from '@/lib/api/memberships';
import { Button, Card, Input } from '@/lib/ui';

const selectCls =
  'w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] hover:border-slate-300';

export default function NewCouponPage() {
  const router = useRouter();
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const createCoupon = useCreateCoupon(tenantId);

  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [scopeType, setScopeType] = useState<CouponScopeType>('org');
  const [venueId, setVenueId] = useState('');
  const [scopeRefId, setScopeRefId] = useState('');
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

  const { data: venues } = useVenues(tenantId);
  const { data: events } = useTenantEvents(tenantId);
  const { data: memberships } = useMemberships(tenantId);
  // useArenas has enabled: Boolean(venueId) — safe to call with '' when no venue selected
  const { data: arenas } = useArenas(scopeType === 'arena' ? venueId : '');

  function resolveScopeId(): string | undefined {
    switch (scopeType) {
      case 'org': return undefined;
      case 'venue': return venueId || undefined;
      default: return scopeRefId || undefined; // arena/event/membership
    }
  }

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
    const scopeId = resolveScopeId();
    if (scopeType !== 'org' && !scopeId) return setErr('Pick the target for this scope.');

    const input: CreateCouponInput = {
      code: code.trim().toUpperCase(),
      scopeType,
      discountType,
      discountValue: discountValueConv,
      visibility,
      ...(description ? { description } : {}),
      ...(scopeId ? { scopeId } : {}),
      ...(discountType === 'percent' && maxDiscountRupees ? { maxDiscountPaise: Math.round(parseFloat(maxDiscountRupees) * 100) } : {}),
      ...(minOrderRupees ? { minOrderPaise: Math.round(parseFloat(minOrderRupees) * 100) } : {}),
      ...(validFromLocal ? { validFrom: new Date(validFromLocal).toISOString() } : {}),
      ...(validUntilLocal ? { validUntil: new Date(validUntilLocal).toISOString() } : {}),
      ...(maxRedemptions ? { maxRedemptions: parseInt(maxRedemptions, 10) } : {}),
      ...(perUserLimit ? { perUserLimit: parseInt(perUserLimit, 10) } : {}),
    };
    try {
      await createCoupon.mutateAsync(input);
      router.push('/coupons');
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!activeTenantId) return <p className="text-sm text-slate-500">Select an organisation first.</p>;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/coupons" className="text-sm text-slate-500 hover:text-slate-800">&larr; Coupons</Link>
      <h1 className="text-xl font-semibold text-[#0f172a]">New coupon</h1>
      <Card title="Details">
        <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
          <Input label="Code" value={code} onChange={(e) => setCode(e.target.value)} required placeholder="SUMMER10" hint="Stored uppercase. Unique within your org." />
          <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Summer sale 10% off" />

          <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Scope</label>
          <select className={selectCls} value={scopeType} onChange={(e) => { setScopeType(e.target.value as CouponScopeType); setScopeRefId(''); setVenueId(''); }}>
            <option value="org">Whole organisation</option>
            <option value="venue">A venue</option>
            <option value="event">A specific event</option>
            <option value="arena">A specific arena</option>
            <option value="membership">A specific membership</option>
          </select>

          {scopeType === 'venue' && (
            <select className={selectCls} value={venueId} onChange={(e) => setVenueId(e.target.value)}>
              <option value="">Select a venue…</option>
              {venues?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )}
          {scopeType === 'event' && (
            <select className={selectCls} value={scopeRefId} onChange={(e) => setScopeRefId(e.target.value)}>
              <option value="">Select an event…</option>
              {events?.map((ev) => <option key={ev.id} value={ev.id}>{ev.name}</option>)}
            </select>
          )}
          {scopeType === 'membership' && (
            <select className={selectCls} value={scopeRefId} onChange={(e) => setScopeRefId(e.target.value)}>
              <option value="">Select a membership…</option>
              {memberships?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          {scopeType === 'arena' && (
            <>
              <select className={selectCls} value={venueId} onChange={(e) => { setVenueId(e.target.value); setScopeRefId(''); }}>
                <option value="">Select a venue…</option>
                {venues?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <select className={selectCls} value={scopeRefId} onChange={(e) => setScopeRefId(e.target.value)} disabled={!venueId}>
                <option value="">Select an arena…</option>
                {arenas?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </>
          )}

          <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Discount type</label>
          <div className="inline-flex w-fit rounded-md border border-slate-200 bg-white p-0.5">
            {(['percent', 'fixed'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setDiscountType(t)}
                className={['rounded px-3 py-1.5 text-sm font-medium', discountType === t ? 'bg-slate-900 text-white' : 'text-slate-600'].join(' ')}>
                {t === 'percent' ? 'Percentage' : 'Fixed (₹)'}
              </button>
            ))}
          </div>
          <Input label={discountType === 'percent' ? 'Discount (%)' : 'Discount (₹)'} type="number" min={0}
            step={discountType === 'percent' ? 0.1 : 1} value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} required />
          {discountType === 'percent' && (
            <Input label="Max discount (₹, optional)" type="number" min={0} step={1} value={maxDiscountRupees} onChange={(e) => setMaxDiscountRupees(e.target.value)} hint="Cap on a percentage discount." />
          )}
          <Input label="Minimum order (₹, optional)" type="number" min={0} step={1} value={minOrderRupees} onChange={(e) => setMinOrderRupees(e.target.value)} />

          <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Visibility</label>
          <select className={selectCls} value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}>
            <option value="private">Private — customers must type the code</option>
            <option value="public">Public — shown in the checkout offers list</option>
          </select>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Valid from (optional)" type="datetime-local" value={validFromLocal} onChange={(e) => setValidFromLocal(e.target.value)} />
            <Input label="Valid until (optional)" type="datetime-local" value={validUntilLocal} onChange={(e) => setValidUntilLocal(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Total max redemptions (optional)" type="number" min={1} value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} />
            <Input label="Per-user limit (optional)" type="number" min={1} value={perUserLimit} onChange={(e) => setPerUserLimit(e.target.value)} />
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => router.push('/coupons')}>Cancel</Button>
            <Button type="submit" loading={createCoupon.isPending}>Create coupon</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
