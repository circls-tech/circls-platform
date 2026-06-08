# Coupon Codes — Partners & Admin Management UI Implementation Plan (Plan 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add coupon management UI to the Partners Portal (`apps/partners`) — a top-level "Coupons" section to create/list/edit org coupons — and to the Admin console (`apps/admin`) — a "Coupons" page for platform-wide (Circls-funded) coupons. Plus the required Help Centre article.

**Architecture:** Both apps are Next.js 15 App Router + React 19 + TanStack Query, calling the `/v1` backend built in Plan 1 via each app's `apiFetch`. The Partners UI follows the existing Events/Memberships CRUD pattern (shared `lib/ui` components + `lib/api/*` hooks); the Admin UI follows the existing Listings/Tenants pattern (inline Tailwind, hooks in `lib/api/queries.ts`). This plan is **UI only** — it binds to endpoints/types already implemented in Plan 1.

**Tech Stack:** Next.js 15, React 19, TanStack Query v5, Tailwind, TypeScript (strict).

Spec: `docs/superpowers/specs/2026-06-08-coupons-transparent-checkout-design.md`. Backend: Plan 1 (`docs/superpowers/plans/2026-06-08-coupons-backend.md`), branch `worktree-coupons-checkout`.

---

## The backend contract (authoritative — bind to THIS, not to any other shape)

Endpoints (all `/v1`, Firebase-authed):
- Org: `GET/POST /v1/tenants/:tenantId/coupons`, `PATCH/DELETE /v1/tenants/:tenantId/coupons/:id`. Caps: `discounts.read` / `discounts.write`.
- Admin: `GET/POST /v1/admin/coupons`, `PATCH/DELETE /v1/admin/coupons/:id`. Caps: `admin.coupons.read` / `admin.coupons.write`.
- **List endpoints return a bare `Coupon[]`** (NOT `{ rows }`). `DELETE` returns **204**. There are **no** activate/deactivate routes — status changes via `PATCH { status }`.

`Coupon` row shape (from `apps/api/src/db/schema/coupons.ts`):
```ts
{
  id: string;
  ownerType: 'platform' | 'tenant';
  tenantId: string | null;
  code: string;
  description: string | null;
  scopeType: 'org' | 'venue' | 'event' | 'arena' | 'membership';
  scopeId: string | null;            // null for 'org'
  discountType: 'percent' | 'fixed';
  discountValue: number;             // basis points when percent; paise when fixed
  maxDiscountPaise: number | null;   // cap for percent
  minOrderPaise: number | null;
  visibility: 'public' | 'private';
  validFrom: string | null;          // ISO-8601
  validUntil: string | null;
  maxRedemptions: number | null;
  perUserLimit: number | null;
  redeemedCount: number;
  status: 'active' | 'paused' | 'expired';
  createdAt: string;
  updatedAt: string;
}
```

POST body (create — `createBody` in `apps/api/src/routes/coupons.ts`): `code` (req), `scopeType` (req), `discountType` (req), `discountValue` (req, positive int), and optional `description, scopeId, maxDiscountPaise, minOrderPaise, visibility, validFrom, validUntil, maxRedemptions, perUserLimit`. Server rule: percent `discountValue` must be 1–10000 (bps); fixed must be > 0 (paise). Non-`org` scope requires `scopeId`; `org` must not have one.

PATCH body (update — `updateBody`): ONLY `description, minOrderPaise, maxDiscountPaise, visibility, validFrom, validUntil, maxRedemptions, perUserLimit, status` are editable. **`code`, `scopeType`, `scopeId`, `discountType`, `discountValue` are immutable** — the edit form must not offer them.

### Unit conversions (do this exactly)
- **Percent:** UI shows percent; `discountValue (bps) = Math.round(percent * 100)` (10% → 1000). Display: `percent = discountValue / 100`.
- **Fixed / money fields** (`maxDiscountPaise`, `minOrderPaise`): UI shows ₹; `paise = Math.round(rupees * 100)`. Display: `₹ = paise / 100`.
- **Dates:** `datetime-local` value → `new Date(local).toISOString()` when set, else omit. Display: slice ISO to `YYYY-MM-DDTHH:mm` (first 16 chars) for the input.

---

## File Structure

**Partners (`apps/partners`):**
- Create `lib/api/coupons.ts` — `Coupon`/input types + `useTenantCoupons`/`useCreateCoupon`/`useUpdateCoupon`/`useDeleteCoupon`.
- Create `app/(protected)/coupons/page.tsx` — list.
- Create `app/(protected)/coupons/new/page.tsx` — create form (with scope picker).
- Create `app/(protected)/coupons/[couponId]/page.tsx` — detail + edit (patchable fields only) + pause/resume + delete.
- Modify `app/(protected)/layout.tsx` — add the nav item.
- Modify `lib/ui/StatusPill.tsx` — add `paused` + `expired` mappings.

**Admin (`apps/admin`):**
- Modify `lib/api/queries.ts` — add admin coupon hooks.
- Modify `lib/api/types.ts` — add the `Coupon` type (or import-shared shape).
- Create `app/(protected)/coupons/page.tsx` — list + create + pause/delete.
- Modify `app/(protected)/layout.tsx` — add the nav item.

**Help (`apps/partners`):**
- Create `content/help/coupons.md`.
- Modify `lib/help/articles.ts` — manifest entry.
- Modify `content/help/README.md` — article→code map row.

---

## Task 1: Partners — coupon types + hooks

**Files:** Create `apps/partners/lib/api/coupons.ts`.

- [ ] **Step 1: Write the hooks file**

Mirror `apps/partners/lib/api/events.ts` (imports `apiFetch` from `./client`, uses `@tanstack/react-query`). Confirm the exact `apiFetch` import path by reading `events.ts` first.

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export type CouponScopeType = 'org' | 'venue' | 'event' | 'arena' | 'membership';
export type CouponDiscountType = 'percent' | 'fixed';
export type CouponVisibility = 'public' | 'private';
export type CouponStatus = 'active' | 'paused' | 'expired';

export interface Coupon {
  id: string;
  ownerType: 'platform' | 'tenant';
  tenantId: string | null;
  code: string;
  description: string | null;
  scopeType: CouponScopeType;
  scopeId: string | null;
  discountType: CouponDiscountType;
  discountValue: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number | null;
  visibility: CouponVisibility;
  validFrom: string | null;
  validUntil: string | null;
  maxRedemptions: number | null;
  perUserLimit: number | null;
  redeemedCount: number;
  status: CouponStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCouponInput {
  code: string;
  description?: string;
  scopeType: CouponScopeType;
  scopeId?: string;
  discountType: CouponDiscountType;
  discountValue: number; // bps (percent) or paise (fixed)
  maxDiscountPaise?: number;
  minOrderPaise?: number;
  visibility?: CouponVisibility;
  validFrom?: string; // ISO-8601
  validUntil?: string;
  maxRedemptions?: number;
  perUserLimit?: number;
}

// PATCH: only these fields are editable server-side.
export interface UpdateCouponPatch {
  description?: string | null;
  minOrderPaise?: number | null;
  maxDiscountPaise?: number | null;
  visibility?: CouponVisibility;
  validFrom?: string | null;
  validUntil?: string | null;
  maxRedemptions?: number | null;
  perUserLimit?: number | null;
  status?: CouponStatus;
}

export function useTenantCoupons(tenantId: string) {
  return useQuery({
    queryKey: ['tenant-coupons', tenantId],
    queryFn: () => apiFetch<Coupon[]>(`/v1/tenants/${tenantId}/coupons`),
    enabled: Boolean(tenantId),
  });
}

export function useCreateCoupon(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCouponInput) =>
      apiFetch<Coupon>(`/v1/tenants/${tenantId}/coupons`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tenant-coupons', tenantId] }),
  });
}

export function useUpdateCoupon(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ couponId, patch }: { couponId: string; patch: UpdateCouponPatch }) =>
      apiFetch<Coupon>(`/v1/tenants/${tenantId}/coupons/${couponId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tenant-coupons', tenantId] }),
  });
}

export function useDeleteCoupon(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (couponId: string) =>
      apiFetch<void>(`/v1/tenants/${tenantId}/coupons/${couponId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tenant-coupons', tenantId] }),
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/partners && pnpm typecheck`
Expected: PASS. (If `apiFetch`'s import path differs, fix it to match `events.ts`.)

- [ ] **Step 3: Commit**

```bash
git add apps/partners/lib/api/coupons.ts
git commit -m "feat(partners): coupon API hooks"
```

---

## Task 2: Partners — StatusPill + nav

**Files:** Modify `apps/partners/lib/ui/StatusPill.tsx`, `apps/partners/app/(protected)/layout.tsx`.

- [ ] **Step 1: Add coupon statuses to StatusPill**

In `lib/ui/StatusPill.tsx`, add to the `STATUS_META` map (next to the existing entries):
```ts
  paused:  { label: 'Paused',  tone: 'warning' },
  expired: { label: 'Expired', tone: 'neutral' },
```
(`active` already maps to "Live"/success — acceptable for coupons.)

- [ ] **Step 2: Add the nav item**

In `app/(protected)/layout.tsx`, add to `NAV_LINKS` after the Memberships line:
```ts
  { href: '/coupons', label: 'Coupons' },
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd apps/partners && pnpm typecheck` → PASS.
```bash
git add apps/partners/lib/ui/StatusPill.tsx "apps/partners/app/(protected)/layout.tsx"
git commit -m "feat(partners): coupons nav + paused/expired status pills"
```

---

## Task 3: Partners — coupons list page

**Files:** Create `apps/partners/app/(protected)/coupons/page.tsx`.

- [ ] **Step 1: Write the list page**

Mirror `app/(protected)/events/page.tsx` (read it for the exact no-tenant `Card` pattern + table styling).

```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useOrg } from '@/lib/org_context';
import { useTenantCoupons, type Coupon } from '@/lib/api/coupons';
import { Button, Card, StatusPill } from '@/lib/ui';

const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short' });

function discountLabel(c: Coupon): string {
  return c.discountType === 'percent'
    ? `${c.discountValue / 100}%`
    : `₹${(c.discountValue / 100).toFixed(2)}`;
}
function scopeLabel(c: Coupon): string {
  return c.scopeType === 'org' ? 'Org-wide' : `${c.scopeType}`;
}

export default function CouponsPage() {
  const router = useRouter();
  const { activeTenantId, tenants } = useOrg();
  const activeTenant = tenants.find((t) => t.id === activeTenantId);
  const { data: coupons, isLoading } = useTenantCoupons(activeTenantId ?? '');

  if (!activeTenantId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-[#0f172a]">Coupons</h1>
        <Card subtitle="Select or create an organisation first to manage its coupons.">
          <p className="text-sm text-slate-500">No active organisation.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[#0f172a]">Coupons</h1>
          {activeTenant && <p className="mt-0.5 text-sm text-slate-500">{activeTenant.name}</p>}
        </div>
        <Button onClick={() => router.push('/coupons/new')}>Create coupon</Button>
      </div>

      {isLoading && <p className="text-sm text-slate-500">Loading coupons…</p>}
      {!isLoading && (!coupons || coupons.length === 0) && (
        <p className="text-sm text-slate-500">No coupons yet for this organisation.</p>
      )}
      {!isLoading && coupons && coupons.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e5e7eb] text-left">
                <th className="pb-2 pr-4 font-medium text-slate-500">Code</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Scope</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Discount</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Visibility</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Redeemed</th>
                <th className="pb-2 pr-4 font-medium text-slate-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f1f5f9]">
              {coupons.map((c) => (
                <tr key={c.id}>
                  <td className="py-2.5 pr-4 font-medium">
                    <Link href={`/coupons/${c.id}`} className="text-brand-600 hover:underline">{c.code}</Link>
                  </td>
                  <td className="py-2.5 pr-4 text-slate-700">{scopeLabel(c)}</td>
                  <td className="py-2.5 pr-4 text-slate-700">{discountLabel(c)}</td>
                  <td className="py-2.5 pr-4 text-slate-700 capitalize">{c.visibility}</td>
                  <td className="py-2.5 pr-4 text-slate-700">
                    {c.maxRedemptions ? `${c.redeemedCount}/${c.maxRedemptions}` : `${c.redeemedCount}/∞`}
                  </td>
                  <td className="py-2.5 pr-4"><StatusPill status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/partners && pnpm typecheck` → PASS.
```bash
git add "apps/partners/app/(protected)/coupons/page.tsx"
git commit -m "feat(partners): coupons list page"
```

---

## Task 4: Partners — create coupon page (with scope picker)

**Files:** Create `apps/partners/app/(protected)/coupons/new/page.tsx`.

This is the contract-sensitive page (conversions + scope picker). Scope picker uses the real list hooks: `useVenues(tenantId)`, `useTenantEvents(tenantId)`, `useMemberships(tenantId)` from `@/lib/api/queries`/`@/lib/api/events`/`@/lib/api/memberships`, and `useArenas(venueId)` (arena scope = pick a venue, then an arena). Read those hook return shapes first (each item has `id` + `name`).

- [ ] **Step 1: Write the create page**

```tsx
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
  const [venueId, setVenueId] = useState(''); // used for venue scope AND as the parent for arena scope
  const [scopeRefId, setScopeRefId] = useState(''); // event/arena/membership id
  const [discountType, setDiscountType] = useState<'percent' | 'fixed'>('percent');
  const [discountValue, setDiscountValue] = useState(''); // percent or ₹ depending on type
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
  const { data: arenas } = useArenas(scopeType === 'arena' ? venueId : '');

  function resolveScopeId(): string | undefined {
    switch (scopeType) {
      case 'org': return undefined;
      case 'venue': return venueId || undefined;
      case 'arena': return scopeRefId || undefined;
      case 'event': return scopeRefId || undefined;
      case 'membership': return scopeRefId || undefined;
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!code.trim()) return setErr('Enter a coupon code.');

    const num = parseFloat(discountValue || '0');
    if (!(num > 0)) return setErr('Enter a positive discount.');
    const discountValuePaiseOrBps =
      discountType === 'percent' ? Math.round(num * 100) : Math.round(num * 100);
    if (discountType === 'percent' && (discountValuePaiseOrBps < 1 || discountValuePaiseOrBps > 10000)) {
      return setErr('Percent discount must be between 0.01% and 100%.');
    }

    const scopeId = resolveScopeId();
    if (scopeType !== 'org' && !scopeId) return setErr('Pick the target for this scope.');

    const input: CreateCouponInput = {
      code: code.trim().toUpperCase(),
      scopeType,
      discountType,
      discountValue: discountValuePaiseOrBps,
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

          <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Scope</label>
          <select className={selectCls} value={scopeType} onChange={(e) => { setScopeType(e.target.value as CouponScopeType); setScopeRefId(''); }}>
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
```

- [ ] **Step 2: Verify hook signatures**

Confirm `useVenues(tenantId)`, `useTenantEvents(tenantId)`, `useMemberships(tenantId)` return arrays of `{ id, name }`, and `useArenas(venueId)` returns `{ id, name }[]` (read `lib/api/queries.ts`, `events.ts`, `memberships.ts`). `useArenas('')` must be safe (disabled when no venue) — if it isn't `enabled`-guarded for empty string, pass a guard. Adjust imports to the real module each hook lives in.

- [ ] **Step 3: Typecheck + commit**

Run: `cd apps/partners && pnpm typecheck` → PASS.
```bash
git add "apps/partners/app/(protected)/coupons/new/page.tsx"
git commit -m "feat(partners): create-coupon page with scope picker"
```

---

## Task 5: Partners — coupon detail + edit page

**Files:** Create `apps/partners/app/(protected)/coupons/[couponId]/page.tsx`.

Edit form exposes ONLY patchable fields (description, min order, max discount cap, visibility, validity, limits, status). Code/scope/discount-type/value are shown read-only. Pause = `PATCH { status: 'paused' }`, Resume = `PATCH { status: 'active' }`. Delete = `DELETE` then route to `/coupons`.

- [ ] **Step 1: Write the page**

```tsx
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
                <div><dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">Visibility</dt><dd className="mt-1 text-sm text-slate-700 capitalize">{coupon.visibility}</dd></div>
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
                <p className="text-xs text-slate-500">Code, scope, and discount type/amount can't be changed after creation. Create a new coupon to change those.</p>
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
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/partners && pnpm typecheck` → PASS.
```bash
git add "apps/partners/app/(protected)/coupons/[couponId]/page.tsx"
git commit -m "feat(partners): coupon detail/edit + pause/resume/delete"
```

---

## Task 6: Help Centre article

**Files:** Create `apps/partners/content/help/coupons.md`; modify `apps/partners/lib/help/articles.ts` and `apps/partners/content/help/README.md`.

- [ ] **Step 1: Manifest entry**

In `lib/help/articles.ts`, add to `HELP_ARTICLES` (pick an `order` after memberships; bump later entries if `order` must stay unique/ascending — read the file and choose an unused order or renumber the tail consistently):
```ts
  {
    slug: 'coupons',
    title: 'Creating and managing discount coupons',
    category: 'Discounts',
    summary:
      'Create percentage or fixed-amount discount codes, scope them to your org / a venue / a specific event, arena or membership, set validity and redemption limits, and choose whether they are public or private.',
    order: 7,
  },
```

- [ ] **Step 2: Article body — `apps/partners/content/help/coupons.md`** (plain GFM, no frontmatter):

```markdown
Coupons are discount codes your customers apply at checkout to reduce the price of an event, membership, or court booking. The discount comes off your base price; Razorpay's payment-processing charge is added on top of the reduced price (shown to the customer as "Other charges (incl taxes)").

## Creating a coupon

Go to **Coupons** in the sidebar and click **Create coupon**, then set:

- **Code** — e.g. `SUMMER10`. Stored in uppercase and must be unique within your organisation. Customers type this at checkout (or pick it from the offers list if it's public).
- **Scope** — where the coupon applies:
  - **Whole organisation** — any of your events, memberships and bookings.
  - **A venue** — anything at that venue.
  - **A specific event / arena / membership** — only that item.
- **Discount type** — **Percentage** (e.g. 10% off, with an optional maximum-discount cap in ₹) or **Fixed (₹)** (e.g. ₹50 off).
- **Minimum order (₹)** — optional; the base price must be at least this for the code to apply.
- **Visibility** — **Private** (the customer must know and type the code) or **Public** (the code is offered in a "View available offers" list at checkout).
- **Valid from / until** — optional window; outside it the code won't apply.
- **Total max redemptions** and **Per-user limit** — optional caps on how many times the code can be used overall and by a single customer.

A new coupon is **active** immediately (subject to its validity window).

## How the discount is applied

The discount reduces your **base price**. The customer then pays that reduced base plus the payment-gateway charge. Only one coupon can be used per checkout.

## Statuses

| Status | Meaning |
| --- | --- |
| **active** | Live — usable within its validity window and limits. |
| **paused** | You've paused it; customers can't use it until you resume. |
| **expired** | Past its valid-until date. |

## Editing, pausing, deleting

Open a coupon to see its usage (e.g. `5/100` redeemed). You can edit its description, visibility, minimum order, max-discount cap, validity window, and redemption limits, and **Pause**/**Resume** or **Delete** it. The **code, scope, and discount amount cannot be changed** after creation — create a new coupon if you need different ones.

## Who pays for the discount

Coupons you create reduce your own revenue for that sale. Circls-wide promotional codes (created by the Circls team) are funded by Circls — your payout is unaffected by those.
```

- [ ] **Step 3: README map row**

In `content/help/README.md`, add a row to the article→code table (after the `memberships.md` row):
```markdown
| `coupons.md` | Coupon create/edit/pause/delete, scope, discount type, visibility, limits | `apps/partners/app/(protected)/coupons/`, `apps/partners/lib/api/coupons.ts`, `apps/api/src/routes/coupons.ts`, `apps/api/src/routes/checkout.ts`, `apps/api/src/db/schema/coupons.ts` |
```

- [ ] **Step 4: Verify + commit**

If the Help Centre has a manifest↔file sync test, run it (`grep -rl "HELP_ARTICLES" apps/partners` for a test). Otherwise `cd apps/partners && pnpm typecheck`.
```bash
git add apps/partners/content/help/coupons.md apps/partners/lib/help/articles.ts apps/partners/content/help/README.md
git commit -m "docs(partners): coupons help article"
```

---

## Task 7: Admin — coupon types + hooks

**Files:** Modify `apps/admin/lib/api/types.ts`, `apps/admin/lib/api/queries.ts`.

- [ ] **Step 1: Type**

Add a `Coupon` interface to `apps/admin/lib/api/types.ts` identical to the Partners one in Task 1 (copy the field list verbatim — same backend row).

- [ ] **Step 2: Hooks**

Add to `apps/admin/lib/api/queries.ts`, mirroring the existing `useAdminListings`/`useApproveListing` style (note: it uses `useAuth()` + `enabled: Boolean(user)` and a `qs(...)` query-string helper — read the file and reuse them). **The list returns a bare `Coupon[]`.**

```ts
export function useAdminCoupons() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['admin', 'coupons'],
    enabled: Boolean(user),
    queryFn: () => apiFetch<Coupon[]>('/v1/admin/coupons'),
  });
}

export interface AdminCreateCouponBody {
  code: string;
  description?: string;
  scopeType: 'org' | 'venue' | 'event' | 'arena' | 'membership';
  scopeId?: string;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  maxDiscountPaise?: number;
  minOrderPaise?: number;
  visibility?: 'public' | 'private';
  validFrom?: string;
  validUntil?: string;
  maxRedemptions?: number;
  perUserLimit?: number;
}

export function useCreateAdminCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AdminCreateCouponBody) =>
      apiFetch<Coupon>('/v1/admin/coupons', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'coupons'] }),
  });
}

export function useUpdateAdminCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; patch: { status?: 'active' | 'paused' | 'expired'; visibility?: 'public' | 'private'; validUntil?: string | null } }) =>
      apiFetch<Coupon>(`/v1/admin/coupons/${args.id}`, { method: 'PATCH', body: JSON.stringify(args.patch) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'coupons'] }),
  });
}

export function useDeleteAdminCoupon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/v1/admin/coupons/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'coupons'] }),
  });
}
```
Import `Coupon` from `./types`. Match the file's existing import of `apiFetch`, `useAuth`, `useQuery`/`useMutation`/`useQueryClient`.

- [ ] **Step 3: Typecheck + commit**

Run: `cd apps/admin && pnpm typecheck` → PASS.
```bash
git add apps/admin/lib/api/types.ts apps/admin/lib/api/queries.ts
git commit -m "feat(admin): coupon API hooks"
```

---

## Task 8: Admin — coupons page + nav

**Files:** Create `apps/admin/app/(protected)/coupons/page.tsx`; modify `apps/admin/app/(protected)/layout.tsx`.

Platform coupons are funded by Circls (the backend records `funder='platform'`). Admin creates **platform-wide** coupons (scope `org` = applies across the platform) or targets a specific item by pasting its UUID (the admin console has no per-tenant item picker — keep a free-text `scopeId` for non-org scopes, matching how the audit-log page takes a UUID).

- [ ] **Step 1: Nav**

In `apps/admin/app/(protected)/layout.tsx`, add to `NAV_LINKS`:
```ts
  { href: '/coupons', label: 'Coupons' },
```

- [ ] **Step 2: Page** — `apps/admin/app/(protected)/coupons/page.tsx`

Mirror the inline-Tailwind style of `app/(protected)/listings/page.tsx` (no shared UI lib). List all platform coupons, a "New coupon" form (collapsible), pause/resume + delete per row.

```tsx
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

  // form state
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
      discountValue: Math.round(num * 100), // bps for percent, paise for fixed
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
                <td className="px-4 py-2.5 text-xs text-slate-600">{c.scopeType === 'org' ? 'Platform-wide' : `${c.scopeType}`}</td>
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
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd apps/admin && pnpm typecheck` → PASS.
```bash
git add "apps/admin/app/(protected)/coupons/page.tsx" "apps/admin/app/(protected)/layout.tsx"
git commit -m "feat(admin): platform coupons management page"
```

---

## Task 9: Full verification (both apps)

- [ ] **Step 1: Typecheck both apps**

Run: `cd apps/partners && pnpm typecheck` → PASS. `cd apps/admin && pnpm typecheck` → PASS.

- [ ] **Step 2: Lint/build**

Run each app's build (catches App Router issues the typecheck misses): `cd apps/partners && pnpm build` and `cd apps/admin && pnpm build`. Expected: success. (If `build` requires env/secrets and fails for unrelated reasons, fall back to `pnpm lint` and note it.)

- [ ] **Step 3: Manual smoke (requires the API running + a DB, and Plan 1 deployed)**

These apps have no component-test harness, so verify by hand against a running backend:
- Partners: "Coupons" appears in the sidebar; create a public org-wide 10% coupon; it lists with status "Live"; open it, pause it (status → Paused), resume, then edit the description/visibility and save; create a venue-scoped and an event-scoped coupon via the picker; delete one.
- Admin: "Coupons" appears; create a platform-wide percentage coupon; it lists; pause/resume; delete.
- Help: open `/help/coupons` in the partners app and confirm it renders.
- Cross-check: a public coupon created here shows up in the consumer checkout offers list (verifies the `GET /v1/consumer/coupons` wiring from Plan 1) — this also exercises Plan 3/4.

- [ ] **Step 4: Final commit (if any build-config tweaks were needed)**

```bash
git add -A
git commit -m "chore(ui): coupon management verification"
```

---

## Self-Review notes (for the implementer)

- **Bind to the real contract** (top of this doc), NOT to any other coupon shape. Especially: list endpoints return a bare array; PATCH only accepts `description/minOrderPaise/maxDiscountPaise/visibility/validFrom/validUntil/maxRedemptions/perUserLimit/status`; there are no activate/deactivate routes (use `PATCH { status }`); `code/scope/discountType/discountValue` are immutable.
- **Unit conversions** (percent↔bps via ×100/÷100; ₹↔paise via ×100/÷100) must be applied on every read and write. Double-check the create page sends bps for percent.
- **Verify hook signatures before coding** Task 4: `useVenues`, `useTenantEvents`, `useMemberships`, `useArenas` real names/return shapes (item `{ id, name }`); fix imports to the module each lives in. Guard `useArenas('')`.
- **Help article ships here** (repo CLAUDE.md requires docs in the same PR as the partner-facing feature). Keep `articles.ts` `order` values ascending/consistent.
- This plan is UI only; runtime behaviour depends on Plan 1 being deployed with a migrated DB. The manual smoke steps need the API + DB running.
