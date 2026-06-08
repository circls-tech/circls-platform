# Coupon Codes — Web Consumer Checkout Modal Implementation Plan (Plan 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "click Book/Register/Buy → straight to Razorpay" flow in the web consumer app (`apps/consumer`) with a **transparent checkout modal** that itemises base price, applied discount, the "Other charges (incl taxes)" gross-up, and the total; lets the user apply a coupon (typed, or picked from public offers for events/memberships); then pays via Razorpay (or confirms directly when the total is free).

**Architecture:** A `CheckoutProvider` at the app root exposes `openCheckout(item, prefill)` via context and renders one `<CheckoutModal>`. The modal calls the Plan 1 quote endpoint (`POST /v1/consumer/checkout/quote`) to render the live breakdown, the public-offers endpoint (`GET /v1/consumer/coupons`) for the picker, and on "Pay" calls the existing booking mutation (now carrying `couponCode`) then `openRazorpayCheckout`. The book buttons just call `openCheckout(...)`; the old per-page `useCheckout` direct-to-Razorpay path and `CheckoutBanner` are removed.

**Tech Stack:** Next.js 15 App Router, React 19, TanStack Query v5, Tailwind v4, Firebase Auth. Shared UI in `apps/consumer/lib/ui` (`Button`, `Card`, `Input`; **no Modal yet** — this plan adds one).

Spec: `docs/superpowers/specs/2026-06-08-coupons-transparent-checkout-design.md`. Depends on Plan 1 endpoints (`/v1/consumer/checkout/quote`, `/v1/consumer/coupons`, and `couponCode` accepted by the three booking routes).

---

## The backend contract this binds to (from Plan 1)

**Quote** — `POST /v1/consumer/checkout/quote` (Firebase-authed). Body is one of:
```ts
{ itemType: 'event'; eventId: string; couponCode?: string }
{ itemType: 'membership'; membershipId: string; couponCode?: string }
{ itemType: 'slot'; slotIds: string[]; couponCode?: string }
```
Returns:
```ts
{
  basePaise: number;
  discountPaise: number;
  discountedBasePaise: number;
  otherChargesPaise: number;   // the "Other charges (incl taxes)" line
  totalPaise: number;          // 0 ⇒ free
  coupon: { id: string; code: string; description: string | null } | null;
  error?: string;              // e.g. 'coupon_not_found' — coupon NOT applied, base pricing returned
}
```

**Public offers** — `GET /v1/consumer/coupons?itemType=event|membership&itemId=<id>` (public). Returns `{ rows: Array<{ code, description, discountType, discountValue, maxDiscountPaise, minOrderPaise }> }`. **Slots are not supported here** — for slot checkouts, only manual code entry (the quote endpoint still validates a typed code for slots).

**Booking** — the existing routes now accept an optional `couponCode`:
- `POST /v1/consumer/bookings` (slots) → `{ bookingId, payment: { orderId, keyId, amountPaise, currency } }`
- `POST /v1/consumer/events/:eventId/book` → `{ booking, providerOrderId?, keyId?, amountPaise? }`
- `POST /v1/consumer/memberships/:membershipId/purchase` → `{ userMembershipId, orderId?, keyId?, amountPaise? }`

`openRazorpayCheckout({ keyId, orderId, amountPaise, currency, description?, prefill? })` (in `lib/checkout.ts`) returns `{ kind: 'paid' | 'dismissed' | 'reserved' }`; empty `keyId`/`orderId` ⇒ `reserved` (payments-not-enabled stub).

**Free vs reserved disambiguation:** use the quote's `totalPaise`. `totalPaise === 0` ⇒ the booking is free/confirmed (success). `totalPaise > 0` with an order id ⇒ Razorpay. `totalPaise > 0` with no order id ⇒ reserved (stub).

---

## File Structure

**Create:**
- `apps/consumer/lib/ui/Modal.tsx` — minimal portal/overlay dialog; export from `lib/ui/index.ts`.
- `apps/consumer/lib/api/checkout.ts` — `useCheckoutQuote()` + `usePublicCoupons()` hooks + quote/offer types.
- `apps/consumer/lib/checkout/types.ts` — `CheckoutItem` descriptor + prefill type.
- `apps/consumer/lib/checkout/CheckoutProvider.tsx` — context (`openCheckout`) + renders `<CheckoutModal>`.
- `apps/consumer/lib/checkout/CheckoutModal.tsx` — the modal UI + pay flow.

**Modify:**
- `apps/consumer/lib/api/consumer.ts` + its types — add `couponCode` to the three booking inputs; change `usePurchaseMembership` to take an object.
- `apps/consumer/lib/ui/index.ts` — export `Modal`.
- `apps/consumer/app/providers.tsx` — wrap children in `<CheckoutProvider>`.
- `apps/consumer/app/venues/[venueId]/page.tsx` — buttons call `openCheckout`; remove `CheckoutBanner` + `useCheckout`.
- `apps/consumer/app/events/[id]/page.tsx` — book button calls `openCheckout`; remove `CheckoutBanner` + `useCheckout`.
- (If a standalone membership detail page has a Buy button, update it the same way — grep for `buyMembershipNow`.)

**Remove (after call sites are migrated):**
- `apps/consumer/lib/useCheckout.ts` — superseded by the provider/modal. (Delete only once nothing imports it — verify with grep.)

---

## Task 1: Add `couponCode` to the booking API hooks

**Files:** Modify `apps/consumer/lib/api/consumer.ts` and its types file (`apps/consumer/lib/api/types.ts` — confirm where `BookSlotsInput`/`BookEventInput` live).

- [ ] **Step 1: Extend the input types**

```ts
export interface BookSlotsInput {
  slotIds: string[];
  customerName: string;
  customerContact: string;
  note?: string;
  couponCode?: string;   // NEW
}

export interface BookEventInput {
  eventId: string;
  name?: string;
  contact?: string;
  couponCode?: string;   // NEW
}

export interface PurchaseMembershipInput {  // NEW (was a bare string param)
  membershipId: string;
  couponCode?: string;
}
```

- [ ] **Step 2: Forward `couponCode` in the hooks**

`useBookSlots` already spreads the whole `BookSlotsInput` into the body — `couponCode` flows through automatically once it's on the type. `useBookEvent` spreads `...body` after pulling `eventId` — `couponCode` flows through. Change `usePurchaseMembership` to take the object:

```ts
export function usePurchaseMembership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ membershipId, couponCode }: PurchaseMembershipInput) =>
      apiFetch<MembershipPurchaseResult>(
        `/v1/consumer/memberships/${membershipId}/purchase`,
        { method: 'POST', body: JSON.stringify(couponCode ? { couponCode } : {}) },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['my-bookings'] }),
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/consumer && pnpm typecheck` — will FAIL where `buyMembershipNow`/`usePurchaseMembership(id)` is called with a bare string (useCheckout.ts and any page). That's expected; those call sites are migrated in later tasks. If the failures are ONLY in `useCheckout.ts` + pages you'll edit later, proceed; otherwise fix stragglers. (To keep this task green in isolation, you may temporarily update `useCheckout.ts`'s call to `usePurchaseMembership({ membershipId, ... })` — but `useCheckout.ts` is deleted in Task 7, so prefer to land Tasks 1–7 together and run the final typecheck at the end. Commit this task even if `useCheckout.ts` is transiently broken, since the next tasks remove it.)

- [ ] **Step 4: Commit**

```bash
git add apps/consumer/lib/api/consumer.ts apps/consumer/lib/api/types.ts
git commit -m "feat(consumer): accept couponCode in booking API hooks"
```

---

## Task 2: Quote + public-coupons hooks

**Files:** Create `apps/consumer/lib/api/checkout.ts`.

- [ ] **Step 1: Write the hooks**

```ts
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

export type QuoteItem =
  | { itemType: 'event'; eventId: string }
  | { itemType: 'membership'; membershipId: string }
  | { itemType: 'slot'; slotIds: string[] };

export type QuoteRequest = QuoteItem & { couponCode?: string };

export interface QuoteResponse {
  basePaise: number;
  discountPaise: number;
  discountedBasePaise: number;
  otherChargesPaise: number;
  totalPaise: number;
  coupon: { id: string; code: string; description: string | null } | null;
  error?: string;
}

export interface PublicCoupon {
  code: string;
  description: string | null;
  discountType: 'percent' | 'fixed';
  discountValue: number;
  maxDiscountPaise: number | null;
  minOrderPaise: number | null;
}

/** Imperative quote — call on open and whenever the coupon changes. */
export function useCheckoutQuote() {
  return useMutation({
    mutationFn: (req: QuoteRequest) =>
      apiFetch<QuoteResponse>('/v1/consumer/checkout/quote', {
        method: 'POST',
        body: JSON.stringify(req),
      }),
  });
}

/** Public offers for an event or membership (the picker). Slots unsupported. */
export function usePublicCoupons(item: { itemType: 'event' | 'membership'; itemId: string } | null) {
  return useQuery({
    queryKey: ['public-coupons', item?.itemType, item?.itemId],
    enabled: Boolean(item),
    queryFn: () =>
      apiFetch<{ rows: PublicCoupon[] }>(
        `/v1/consumer/coupons?itemType=${item!.itemType}&itemId=${item!.itemId}`,
      ),
  });
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `cd apps/consumer && pnpm typecheck` (this file alone is clean).
```bash
git add apps/consumer/lib/api/checkout.ts
git commit -m "feat(consumer): checkout quote + public coupons hooks"
```

---

## Task 3: Modal primitive

**Files:** Create `apps/consumer/lib/ui/Modal.tsx`; modify `apps/consumer/lib/ui/index.ts`.

- [ ] **Step 1: Write a minimal portal dialog**

```tsx
'use client';

import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-t-[var(--radius-card)] bg-white p-5 shadow-xl sm:rounded-[var(--radius-card)]">
        {title != null && <h2 className="mb-4 text-lg font-semibold text-[var(--color-ink)]">{title}</h2>}
        {children}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Export it**

In `apps/consumer/lib/ui/index.ts` add:
```ts
export { Modal } from './Modal';
export type { ModalProps } from './Modal';
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd apps/consumer && pnpm typecheck` → PASS.
```bash
git add apps/consumer/lib/ui/Modal.tsx apps/consumer/lib/ui/index.ts
git commit -m "feat(consumer): Modal UI primitive"
```

---

## Task 4: Checkout item descriptor

**Files:** Create `apps/consumer/lib/checkout/types.ts`.

- [ ] **Step 1: Write the types**

```ts
/** What the user is buying — drives the quote request, the booking call, and the modal title. */
export type CheckoutItem =
  | { kind: 'slot'; slotIds: string[]; title: string }
  | { kind: 'event'; eventId: string; title: string }
  | { kind: 'membership'; membershipId: string; title: string };

export interface CheckoutPrefill {
  name?: string;
  contact?: string;
}
```

- [ ] **Step 2: Commit** (typecheck is trivially clean)

```bash
git add apps/consumer/lib/checkout/types.ts
git commit -m "feat(consumer): checkout item descriptor types"
```

---

## Task 5: CheckoutModal component

**Files:** Create `apps/consumer/lib/checkout/CheckoutModal.tsx`.

This is the core. It receives the open item + prefill + an `onClose`, drives the quote, coupon entry, offers picker, and the pay flow.

- [ ] **Step 1: Write the modal**

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Button, Input, Modal } from '@/lib/ui';
import { formatPaise } from '@/lib/format';
import { openRazorpayCheckout } from '@/lib/checkout';
import { useBookSlots, useBookEvent, usePurchaseMembership } from '@/lib/api/consumer';
import { useCheckoutQuote, usePublicCoupons, type QuoteRequest, type QuoteResponse } from '@/lib/api/checkout';
import { useAuth } from '@/lib/firebase/auth_context';
import type { CheckoutItem, CheckoutPrefill } from './types';

type Phase =
  | { kind: 'quoting' }
  | { kind: 'ready' }
  | { kind: 'paying' }
  | { kind: 'success'; message: string }
  | { kind: 'reserved'; message: string }
  | { kind: 'error'; message: string };

const COUPON_ERRORS: Record<string, string> = {
  coupon_not_found: 'That code isn’t valid.',
  coupon_expired: 'That code has expired.',
  coupon_not_started: 'That code isn’t active yet.',
  coupon_inactive: 'That code is no longer active.',
  coupon_scope_mismatch: 'That code doesn’t apply to this item.',
  coupon_min_order: 'Your order is below this code’s minimum.',
  coupon_max_redeemed: 'That code has been fully redeemed.',
  coupon_user_limit: 'You’ve already used that code.',
};

function quoteItem(item: CheckoutItem): QuoteRequest {
  switch (item.kind) {
    case 'slot': return { itemType: 'slot', slotIds: item.slotIds };
    case 'event': return { itemType: 'event', eventId: item.eventId };
    case 'membership': return { itemType: 'membership', membershipId: item.membershipId };
  }
}

export function CheckoutModal({ item, prefill, onClose }: { item: CheckoutItem; prefill: CheckoutPrefill; onClose: () => void }) {
  const { user } = useAuth();
  const quote = useCheckoutQuote();
  const bookSlots = useBookSlots();
  const bookEvent = useBookEvent();
  const purchaseMembership = usePurchaseMembership();

  const [phase, setPhase] = useState<Phase>({ kind: 'quoting' });
  const [breakdown, setBreakdown] = useState<QuoteResponse | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [appliedCode, setAppliedCode] = useState<string | undefined>();
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const [showOffers, setShowOffers] = useState(false);

  const offersItem = item.kind === 'event' ? { itemType: 'event' as const, itemId: item.eventId }
    : item.kind === 'membership' ? { itemType: 'membership' as const, itemId: item.membershipId } : null;
  const offers = usePublicCoupons(showOffers ? offersItem : null);

  // (Re)quote on open and whenever the applied coupon changes.
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'quoting' });
    quote
      .mutateAsync({ ...quoteItem(item), ...(appliedCode ? { couponCode: appliedCode } : {}) })
      .then((res) => {
        if (cancelled) return;
        setBreakdown(res);
        setCouponMsg(res.error ? (COUPON_ERRORS[res.error] ?? 'Coupon not applied.') : null);
        if (res.error) setAppliedCode(undefined); // server rejected it; revert to base
        setPhase({ kind: 'ready' });
      })
      .catch((e) => { if (!cancelled) setPhase({ kind: 'error', message: (e as Error).message }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedCode]);

  function applyCode(code: string) {
    const c = code.trim().toUpperCase();
    if (c) { setCodeInput(c); setAppliedCode(c); setShowOffers(false); }
  }
  function clearCode() { setAppliedCode(undefined); setCodeInput(''); setCouponMsg(null); }

  async function onPay() {
    if (!breakdown) return;
    setPhase({ kind: 'paying' });
    try {
      // 1) Create the booking (carrying the coupon). Extract a Razorpay order.
      let order = { orderId: '', keyId: '', amountPaise: breakdown.totalPaise, currency: 'INR' as const };
      if (item.kind === 'slot') {
        const r = await bookSlots.mutateAsync({
          slotIds: item.slotIds,
          customerName: prefill.name ?? user?.displayName ?? 'Guest',
          customerContact: prefill.contact ?? user?.phoneNumber ?? user?.email ?? '',
          ...(appliedCode ? { couponCode: appliedCode } : {}),
        });
        order = { ...r.payment };
      } else if (item.kind === 'event') {
        const r = await bookEvent.mutateAsync({
          eventId: item.eventId,
          ...(prefill.name ? { name: prefill.name } : {}),
          ...(prefill.contact ? { contact: prefill.contact } : {}),
          ...(appliedCode ? { couponCode: appliedCode } : {}),
        });
        order = { orderId: r.providerOrderId ?? '', keyId: r.keyId ?? '', amountPaise: r.amountPaise ?? 0, currency: 'INR' };
      } else {
        const r = await purchaseMembership.mutateAsync({ membershipId: item.membershipId, ...(appliedCode ? { couponCode: appliedCode } : {}) });
        order = { orderId: r.orderId ?? '', keyId: r.keyId ?? '', amountPaise: r.amountPaise ?? 0, currency: 'INR' };
      }

      // 2) Free total ⇒ already confirmed.
      if (breakdown.totalPaise === 0) {
        setPhase({ kind: 'success', message: 'Confirmed! See it in My Bookings.' });
        return;
      }
      // 3) No order despite a non-zero total ⇒ payments not enabled (reserved).
      if (!order.orderId || !order.keyId) {
        setPhase({ kind: 'reserved', message: 'Payments aren’t enabled yet — your booking is reserved.' });
        return;
      }
      // 4) Pay via Razorpay.
      const result = await openRazorpayCheckout({
        keyId: order.keyId, orderId: order.orderId, amountPaise: order.amountPaise, currency: order.currency,
        description: item.title,
        prefill: { ...(prefill.name ? { name: prefill.name } : {}), ...(prefill.contact ? { contact: prefill.contact } : {}) },
      });
      if (result.kind === 'paid') setPhase({ kind: 'success', message: 'Payment received! See it in My Bookings.' });
      else if (result.kind === 'reserved') setPhase({ kind: 'reserved', message: 'Payments aren’t enabled yet — your booking is reserved.' });
      else setPhase({ kind: 'error', message: 'Payment cancelled. Your slot may be held briefly.' });
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message });
    }
  }

  const busy = phase.kind === 'quoting' || phase.kind === 'paying';
  const done = phase.kind === 'success' || phase.kind === 'reserved' || phase.kind === 'error';

  return (
    <Modal open onClose={onClose} title="Checkout">
      <p className="mb-4 text-sm text-[var(--color-text-secondary)]">{item.title}</p>

      {done ? (
        <div className="flex flex-col gap-4">
          <div className={[
            'rounded-[var(--radius)] border px-4 py-3 text-sm',
            phase.kind === 'success' ? 'border-green-200 bg-green-50 text-green-800'
              : phase.kind === 'reserved' ? 'border-amber-200 bg-amber-50 text-amber-800'
              : 'border-red-200 bg-red-50 text-red-700',
          ].join(' ')}>{phase.message}</div>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Line items */}
          <Row label="Base price" value={breakdown ? formatPaise(breakdown.basePaise) : '—'} />
          {breakdown && breakdown.discountPaise > 0 && (
            <Row label={`Discount${appliedCode ? ` (${appliedCode})` : ''}`} value={`−${formatPaise(breakdown.discountPaise)}`} accent />
          )}
          {breakdown && (
            <Row label="Other charges (incl taxes)" value={formatPaise(breakdown.otherChargesPaise)} muted />
          )}
          <div className="my-1 border-t border-[var(--color-border)]" />
          <Row label="Total" value={breakdown ? formatPaise(breakdown.totalPaise) : '—'} bold />

          {/* Coupon entry */}
          {!appliedCode ? (
            <div className="mt-2 flex items-end gap-2">
              <div className="flex-1">
                <Input label="Coupon code" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="SUMMER10" />
              </div>
              <Button variant="secondary" size="sm" onClick={() => applyCode(codeInput)} disabled={!codeInput.trim() || busy}>Apply</Button>
            </div>
          ) : (
            <button type="button" onClick={clearCode} className="mt-1 self-start text-xs font-medium text-[var(--color-text-secondary)] underline">
              Remove coupon
            </button>
          )}
          {couponMsg && <p className="text-xs text-red-600">{couponMsg}</p>}

          {/* Public offers (events + memberships only) */}
          {offersItem && !appliedCode && (
            <div>
              <button type="button" onClick={() => setShowOffers((s) => !s)} className="text-xs font-medium text-[var(--color-text-secondary)] underline">
                {showOffers ? 'Hide offers' : 'View available offers'}
              </button>
              {showOffers && (
                <div className="mt-2 flex flex-col gap-1">
                  {offers.isLoading && <p className="text-xs text-[var(--color-text-secondary)]">Loading…</p>}
                  {offers.data?.rows.length === 0 && <p className="text-xs text-[var(--color-text-secondary)]">No public offers.</p>}
                  {offers.data?.rows.map((o) => (
                    <button key={o.code} type="button" onClick={() => applyCode(o.code)}
                      className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--color-border)] px-3 py-2 text-left text-xs hover:bg-[var(--color-gold-100)]">
                      <span className="font-medium">{o.code}</span>
                      <span className="text-[var(--color-text-secondary)]">
                        {o.discountType === 'percent' ? `${o.discountValue / 100}% off` : `${formatPaise(o.discountValue)} off`}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <Button className="mt-2" onClick={onPay} loading={busy} disabled={!breakdown || busy}>
            {breakdown && breakdown.totalPaise === 0 ? 'Confirm' : `Pay ${breakdown ? formatPaise(breakdown.totalPaise) : ''}`}
          </Button>
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value, muted, accent, bold }: { label: string; value: string; muted?: boolean; accent?: boolean; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={muted ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-ink)]'}>{label}</span>
      <span className={[accent ? 'text-green-700' : 'text-[var(--color-ink)]', bold ? 'font-semibold' : ''].join(' ')}>{value}</span>
    </div>
  );
}
```

- [ ] **Step 2: Verify imports**

Confirm: `openRazorpayCheckout` is the real export name in `lib/checkout.ts`; `formatPaise` in `lib/format.ts`; `useAuth` in `lib/firebase/auth_context`; `Button`/`Input`/`Modal` from `@/lib/ui`. Adjust if any differ. Confirm `Button` accepts `className` (if not, wrap it).

- [ ] **Step 3: Typecheck + commit**

Run: `cd apps/consumer && pnpm typecheck`. (May surface the membership-hook signature from Task 1 — fine, both land together.)
```bash
git add apps/consumer/lib/checkout/CheckoutModal.tsx
git commit -m "feat(consumer): checkout modal with coupon + gross-up breakdown"
```

---

## Task 6: CheckoutProvider + wire into providers

**Files:** Create `apps/consumer/lib/checkout/CheckoutProvider.tsx`; modify `apps/consumer/app/providers.tsx`.

- [ ] **Step 1: Provider**

```tsx
'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/firebase/auth_context';
import { CheckoutModal } from './CheckoutModal';
import type { CheckoutItem, CheckoutPrefill } from './types';

interface CheckoutContextValue {
  openCheckout: (item: CheckoutItem, prefill?: CheckoutPrefill) => void;
}
const CheckoutContext = createContext<CheckoutContextValue | null>(null);

export function useCheckoutModal(): CheckoutContextValue {
  const ctx = useContext(CheckoutContext);
  if (!ctx) throw new Error('useCheckoutModal must be used within <CheckoutProvider>');
  return ctx;
}

export function CheckoutProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState<{ item: CheckoutItem; prefill: CheckoutPrefill } | null>(null);

  const openCheckout = useCallback((item: CheckoutItem, prefill: CheckoutPrefill = {}) => {
    if (!user) { router.push('/login'); return; } // match the app's existing login route
    setOpen({ item, prefill });
  }, [user, router]);

  return (
    <CheckoutContext.Provider value={{ openCheckout }}>
      {children}
      {open && <CheckoutModal item={open.item} prefill={open.prefill} onClose={() => setOpen(null)} />}
    </CheckoutContext.Provider>
  );
}
```

> Confirm the real login route the app redirects to for unauthenticated checkout (read `useCheckout.ts`'s `ensureSignedIn` — it may push `/login` or `/signin` or open a sheet). Match it exactly.

- [ ] **Step 2: Wire into `app/providers.tsx`**

Wrap children with `<CheckoutProvider>` INSIDE `<AuthProvider>` (it depends on `useAuth`) and inside the QueryClientProvider:
```tsx
<QueryClientProvider client={client}>
  <AuthProvider>
    <CheckoutProvider>{children}</CheckoutProvider>
  </AuthProvider>
</QueryClientProvider>
```

- [ ] **Step 3: Typecheck + commit**

Run: `cd apps/consumer && pnpm typecheck`.
```bash
git add apps/consumer/lib/checkout/CheckoutProvider.tsx apps/consumer/app/providers.tsx
git commit -m "feat(consumer): checkout provider mounts the modal app-wide"
```

---

## Task 7: Migrate call sites + remove old useCheckout

**Files:** Modify `apps/consumer/app/venues/[venueId]/page.tsx`, `apps/consumer/app/events/[id]/page.tsx`, any membership detail page; delete `apps/consumer/lib/useCheckout.ts`.

- [ ] **Step 1: Venue page**

Replace `const checkout = useCheckout()` with `const { openCheckout } = useCheckoutModal()` (import from `@/lib/checkout/CheckoutProvider`). Update handlers:
- Slot: `handleBook(slotId)` → `openCheckout({ kind: 'slot', slotIds: [slotId], title: \`${arena.name} · ${slotLabel}\` })`. (Use whatever arena/slot label fields the card already has; a sensible title string.)
- Event card: `onClick={() => openCheckout({ kind: 'event', eventId: event.id, title: event.name }, prefillFromUser(user))}`.
- Membership card: `onClick={() => openCheckout({ kind: 'membership', membershipId: membership.id, title: membership.name }, prefillFromUser(user))}`.

Remove the `<CheckoutBanner .../>` render and the `CheckoutBanner` function (no longer needed — the modal shows results). Remove `loading={checkout.busy}` (buttons no longer track that; the modal owns busy state) — or keep buttons enabled. Drop now-unused imports (`useCheckout`, `CheckoutState`).

Define a small local helper if convenient:
```ts
const prefillFromUser = (u: typeof user) => ({
  ...(u?.displayName ? { name: u.displayName } : {}),
  ...(u?.phoneNumber ? { contact: u.phoneNumber } : {}),
});
```

- [ ] **Step 2: Event detail page**

Same: replace `useCheckout` with `useCheckoutModal`; book button → `openCheckout({ kind: 'event', eventId: ev.id, title: ev.name }, prefillFromUser(user))`. Remove `CheckoutBanner`.

- [ ] **Step 3: Membership detail page (if any)**

Grep `grep -rn "buyMembershipNow\|useCheckout" apps/consumer/app` and migrate every remaining call site the same way.

- [ ] **Step 4: Delete the old hook**

Confirm nothing imports it: `grep -rn "useCheckout\b" apps/consumer` returns only the deleted file. Then `git rm apps/consumer/lib/useCheckout.ts`. (Keep `lib/checkout.ts` — the Razorpay helper is still used by the modal.)

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/consumer && pnpm typecheck` → PASS (this is the first point the whole consumer app typechecks end-to-end).
```bash
git add -A apps/consumer
git commit -m "feat(consumer): open checkout modal from book/buy/register buttons"
```

---

## Task 8: Full verification

- [ ] **Step 1: Typecheck + build**

Run: `cd apps/consumer && pnpm typecheck` → PASS. Then `cd apps/consumer && pnpm build` → success (catches App Router / client-component issues — e.g. `createPortal` needs the file `'use client'`, which Modal has).

- [ ] **Step 2: Grep for stragglers**

Run: `grep -rn "CheckoutBanner\|useCheckout\b\|buyMembershipNow\|bookSlotsNow\|bookEventNow" apps/consumer` → expect no live references (only possibly the new provider/modal). Fix any leftover.

- [ ] **Step 3: Manual smoke (requires API + DB running, Plan 1 deployed)**

No component-test harness exists. Verify by hand:
- Click "Book" on a paid event → modal opens showing Base price, Other charges (incl taxes), Total (= base ÷ 0.9764, rounded up); type an invalid code → inline error, total unchanged; apply a valid public offer from the list → Discount line appears, total drops; Pay → Razorpay opens (or "reserved" if payments disabled) → success state.
- Free event (or 100%-off coupon) → button/CTA reads "Confirm"; confirming shows success without Razorpay.
- Slot booking → modal shows breakdown; manual coupon entry works; no offers list (expected).
- Membership → same as event.

- [ ] **Step 4: Final commit (if build tweaks were needed)**

```bash
git add -A
git commit -m "chore(consumer): checkout modal verification"
```

---

## Self-Review notes (for the implementer)

- **Bind to the Plan 1 contract** at the top of this doc. The quote endpoint is the single source of displayed pricing; never compute the gross-up client-side. The booking endpoints re-validate the coupon server-side regardless.
- **Free vs reserved** is disambiguated by `quote.totalPaise === 0` (free/confirmed) vs a missing order with `totalPaise > 0` (stub/reserved). Don't conflate them.
- **The offers picker is event/membership only** (the Plan 1 `GET /v1/consumer/coupons` query schema excludes slots). Slots get manual code entry; that's intended, not a gap to fix here.
- **Re-quote on coupon change** via the `useEffect([appliedCode])`. A server-rejected coupon (`res.error`) reverts to base pricing and shows the message — the customer is never blocked from paying base price.
- **Verify the real login route** in `ensureSignedIn` before deleting `useCheckout.ts`, and confirm `openRazorpayCheckout`/`formatPaise`/`useAuth` export names.
- Depends on Plan 1 deployed with a migrated DB; the manual smoke needs the API running. These Next apps have no component-test harness, so typecheck + `pnpm build` + manual smoke is the verification bar (same as Plan 2).
