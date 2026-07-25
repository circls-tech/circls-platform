'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal } from '@/lib/ui';
import { formatPaiseExact } from '@/lib/format';
import { openRazorpayCheckout } from '@/lib/checkout';
import { openStripeCheckout } from '@/lib/checkout_stripe';
import { useBookSlots, useBookEvent, useMyProfile, usePurchaseMembership } from '@/lib/api/consumer';
import { useCheckoutQuote, usePublicCoupons, type QuoteRequest, type QuoteResponse } from '@/lib/api/checkout';
import { useAuth } from '@/lib/firebase/auth_context';
import { ContactDetailsForm } from './ContactDetailsForm';
import type { CheckoutItem, CheckoutPrefill } from './types';

type Phase =
  | { kind: 'quoting' } | { kind: 'ready' } | { kind: 'paying' }
  | { kind: 'success'; message: string } | { kind: 'reserved'; message: string } | { kind: 'error'; message: string };

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
    case 'event': return { itemType: 'event', eventId: item.eventId, lines: item.lines.map((l) => ({ tierId: l.tierId, quantity: l.quantity })) };
    case 'membership': return { itemType: 'membership', membershipId: item.membershipId, ...(item.membershipTierId ? { membershipTierId: item.membershipTierId } : {}) };
  }
}

export function CheckoutModal({ item, prefill, onSuccess, onClose }: { item: CheckoutItem; prefill: CheckoutPrefill; onSuccess?: () => void; onClose: () => void }) {
  const { user } = useAuth();
  const profile = useMyProfile();
  const quote = useCheckoutQuote();
  const bookSlots = useBookSlots();
  const bookEvent = useBookEvent();
  const purchaseMembership = usePurchaseMembership();

  const [phase, setPhase] = useState<Phase>({ kind: 'quoting' });
  const [breakdown, setBreakdown] = useState<QuoteResponse | null>(null);
  // A code handed in by the opener (offers strip on the event page) starts
  // applied; the initial quote validates it like any typed code.
  const initialCode = prefill.couponCode?.trim().toUpperCase() || undefined;
  const [codeInput, setCodeInput] = useState(initialCode ?? '');
  const [appliedCode, setAppliedCode] = useState<string | undefined>(initialCode);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);

  const offersItem = item.kind === 'event' ? { itemType: 'event' as const, itemId: item.eventId }
    : item.kind === 'membership' ? { itemType: 'membership' as const, itemId: item.membershipId } : null;
  // Load public offers eagerly (event/membership) so the picker dropdown is populated.
  const offers = usePublicCoupons(offersItem);

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'quoting' });
    quote
      .mutateAsync({ ...quoteItem(item), ...(appliedCode ? { couponCode: appliedCode } : {}) })
      .then((res) => {
        if (cancelled) return;
        setBreakdown(res);
        setCouponMsg(res.error ? (COUPON_ERRORS[res.error] ?? 'Coupon not applied.') : null);
        if (res.error) setAppliedCode(undefined);
        setPhase({ kind: 'ready' });
      })
      .catch((e) => { if (!cancelled) setPhase({ kind: 'error', message: (e as Error).message }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedCode]);

  // Fire onSuccess once the booking exists (paid / reserved / free-confirmed) so
  // callers like the cart can clear themselves. 'error' means no booking was
  // created (e.g. payment cancelled), so we deliberately don't fire there.
  const firedSuccess = useRef(false);
  useEffect(() => {
    if (!firedSuccess.current && (phase.kind === 'success' || phase.kind === 'reserved')) {
      firedSuccess.current = true;
      onSuccess?.();
    }
  }, [phase, onSuccess]);

  function applyCode(code: string) {
    const c = code.trim().toUpperCase();
    if (c) { setCodeInput(c); setAppliedCode(c); }
  }
  function clearCode() { setAppliedCode(undefined); setCodeInput(''); setCouponMsg(null); }

  async function onPay() {
    if (!breakdown) return;
    setPhase({ kind: 'paying' });
    try {
      let order: { gateway: 'razorpay' | 'stripe'; orderId: string; keyId: string; clientSecret: string; amountPaise: number; currency: string } =
        { gateway: 'razorpay', orderId: '', keyId: '', clientSecret: '', amountPaise: breakdown.totalPaise, currency: breakdown.currency ?? 'INR' };
      if (item.kind === 'slot') {
        const r = await bookSlots.mutateAsync({
          slotIds: item.slotIds,
          customerName: prefill.name ?? profile.data?.displayName ?? user?.displayName ?? 'Guest',
          customerContact: prefill.contact ?? user?.phoneNumber ?? profile.data?.email ?? user?.email ?? '',
          ...(appliedCode ? { couponCode: appliedCode } : {}),
        });
        order = { ...r.payment, clientSecret: r.payment.clientSecret ?? '' };
      } else if (item.kind === 'event') {
        const name = prefill.name ?? profile.data?.displayName;
        const contact = prefill.contact ?? user?.phoneNumber ?? profile.data?.email;
        const r = await bookEvent.mutateAsync({
          eventId: item.eventId,
          lines: item.lines.map((l) => ({ tierId: l.tierId, quantity: l.quantity })),
          ...(name ? { name } : {}),
          ...(contact ? { contact } : {}),
          ...(appliedCode ? { couponCode: appliedCode } : {}),
        });
        order = { gateway: r.gateway ?? 'razorpay', orderId: r.providerOrderId ?? '', keyId: r.keyId ?? '', clientSecret: r.clientSecret ?? '', amountPaise: r.amountPaise ?? 0, currency: r.currency ?? 'INR' };
      } else {
        const r = await purchaseMembership.mutateAsync({ membershipId: item.membershipId, ...(item.membershipTierId ? { membershipTierId: item.membershipTierId } : {}), ...(appliedCode ? { couponCode: appliedCode } : {}) });
        order = { gateway: r.gateway ?? 'razorpay', orderId: r.orderId ?? '', keyId: r.keyId ?? '', clientSecret: r.clientSecret ?? '', amountPaise: r.amountPaise ?? 0, currency: r.currency ?? 'INR' };
      }

      if (breakdown.totalPaise === 0) { setPhase({ kind: 'success', message: 'Confirmed! See it in My Bookings.' }); return; }
      // Stripe opens from the client secret; Razorpay from the order id. Either
      // way an empty browser key means stub mode → the booking is reserved.
      const canOpen = order.keyId && (order.gateway === 'stripe' ? order.clientSecret : order.orderId);
      if (!canOpen) { setPhase({ kind: 'reserved', message: 'Payments aren’t enabled yet — your booking is reserved.' }); return; }

      const result = order.gateway === 'stripe'
        ? await openStripeCheckout({
            publishableKey: order.keyId, clientSecret: order.clientSecret,
            payLabel: `Pay ${formatPaiseExact(order.amountPaise, order.currency)}`,
            description: item.title,
          })
        : await openRazorpayCheckout({
            keyId: order.keyId, orderId: order.orderId, amountPaise: order.amountPaise, currency: order.currency,
            description: item.title,
            prefill: { ...(prefill.name ? { name: prefill.name } : {}), ...(prefill.contact ? { contact: prefill.contact } : {}) },
          });
      if (result.kind === 'paid') setPhase({ kind: 'success', message: 'Payment received! See it in My Bookings.' });
      else if (result.kind === 'reserved') setPhase({ kind: 'reserved', message: 'Payments aren’t enabled yet — your booking is reserved.' });
      else setPhase({ kind: 'error', message: 'Payment cancelled. Your slot may be held briefly.' });
    } catch (e) {
      const raw = (e as Error).message;
      const message = /sold out/i.test(raw)
        ? 'A ticket tier just sold out — go back and adjust quantities.'
        : raw;
      setPhase({ kind: 'error', message });
    }
  }

  const busy = phase.kind === 'quoting' || phase.kind === 'paying';
  const done = phase.kind === 'success' || phase.kind === 'reserved' || phase.kind === 'error';
  // Display currency: the caller seeds it from the item's venue/location
  // country (instant), then the server quote confirms it (authoritative).
  // The payment order's own currency always comes from the API.
  const cur = breakdown?.currency ?? item.currency ?? 'INR';

  // First booking only: the profile has just a phone number, so collect name +
  // email before showing the pay button. Once saved (the mutation writes the
  // fresh profile into the cache) this gate never reappears. A failed profile
  // fetch does not block payment — the gate only engages on a loaded profile.
  const needsContactDetails =
    profile.isSuccess &&
    (!(profile.data.displayName ?? '').trim() || !(profile.data.email ?? '').trim());

  return (
    <Modal open onClose={onClose} title="Checkout">
      <p className="mb-4 text-sm text-[var(--color-text-secondary)]">{item.title}</p>
      {!done && needsContactDetails ? (
        <ContactDetailsForm
          initialName={(profile.data?.displayName ?? prefill.name ?? user?.displayName ?? '').trim()}
          initialEmail={(profile.data?.email ?? user?.email ?? '').trim()}
        />
      ) : done ? (
        <div className="flex flex-col gap-4">
          <div className={[
            'rounded-[var(--radius)] border-[2.5px] border-ink px-4 py-3 text-sm font-medium shadow-offset-sm',
            phase.kind === 'success' ? 'bg-tone-success-bg text-tone-success-text'
              : phase.kind === 'reserved' ? 'bg-tone-warning-bg text-tone-warning-text'
              : 'bg-tone-danger-bg text-tone-danger-text',
          ].join(' ')}>{phase.message}</div>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {item.kind === 'event' && item.lines.map((l) => (
            <Row key={l.tierId} label={`${l.tierName} × ${l.quantity}`} value={formatPaiseExact(l.unitPricePaise * l.quantity, cur)} muted />
          ))}
          <Row label="Base price" value={breakdown ? formatPaiseExact(breakdown.basePaise, cur) : '—'} />
          {breakdown && breakdown.discountPaise > 0 && (
            <Row label={`Discount${appliedCode ? ` (${appliedCode})` : ''}`} value={`−${formatPaiseExact(breakdown.discountPaise, cur)}`} accent />
          )}
          {breakdown && <Row label="Other charges (incl taxes)" value={formatPaiseExact(breakdown.otherChargesPaise, cur)} muted />}
          <div className="my-1 border-t-[1.5px] border-dashed border-ink/25" />
          <Row label="Total" value={breakdown ? formatPaiseExact(breakdown.totalPaise, cur) : '—'} bold />

          {!appliedCode ? (
            <div className="mt-2 flex flex-col gap-2">
              {offersItem && (offers.data?.rows.length ?? 0) > 0 && (
                <select
                  aria-label="Available offers"
                  className="w-full rounded-[var(--radius)] border-[2px] border-ink bg-white px-3 py-2 text-sm text-[var(--color-ink)]"
                  value=""
                  onChange={(e) => { if (e.target.value) applyCode(e.target.value); }}
                  disabled={busy}
                >
                  <option value="">Select an offer…</option>
                  {offers.data?.rows.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.code} — {o.discountType === 'percent' ? `${o.discountValue / 100}% off` : `${formatPaiseExact(o.discountValue, cur)} off`}
                    </option>
                  ))}
                </select>
              )}
              <div className="flex items-end gap-2">
                <div className="flex-1"><Input label="Coupon code" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="Type a code" /></div>
                <Button variant="secondary" size="sm" onClick={() => applyCode(codeInput)} disabled={!codeInput.trim() || busy}>Apply</Button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={clearCode} className="mt-1 self-start text-xs font-medium text-[var(--color-text-secondary)] underline">Remove coupon</button>
          )}
          {couponMsg && <p className="text-xs font-semibold text-petal-red">{couponMsg}</p>}

          {/* profile.isLoading keeps a first-time booker from paying before the
              contact-details gate has had a chance to engage. */}
          <Button className="mt-2" onClick={onPay} loading={busy} disabled={!breakdown || busy || profile.isLoading}>
            {breakdown && breakdown.totalPaise === 0 ? 'Confirm' : `Pay ${breakdown ? formatPaiseExact(breakdown.totalPaise, cur) : ''}`}
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
      <span className={[accent ? 'text-petal-green' : 'text-[var(--color-ink)]', bold ? 'font-display font-extrabold' : ''].join(' ')}>{value}</span>
    </div>
  );
}
