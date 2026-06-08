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

  function applyCode(code: string) {
    const c = code.trim().toUpperCase();
    if (c) { setCodeInput(c); setAppliedCode(c); setShowOffers(false); }
  }
  function clearCode() { setAppliedCode(undefined); setCodeInput(''); setCouponMsg(null); }

  async function onPay() {
    if (!breakdown) return;
    setPhase({ kind: 'paying' });
    try {
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

      if (breakdown.totalPaise === 0) { setPhase({ kind: 'success', message: 'Confirmed! See it in My Bookings.' }); return; }
      if (!order.orderId || !order.keyId) { setPhase({ kind: 'reserved', message: 'Payments aren’t enabled yet — your booking is reserved.' }); return; }

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
          <Row label="Base price" value={breakdown ? formatPaise(breakdown.basePaise) : '—'} />
          {breakdown && breakdown.discountPaise > 0 && (
            <Row label={`Discount${appliedCode ? ` (${appliedCode})` : ''}`} value={`−${formatPaise(breakdown.discountPaise)}`} accent />
          )}
          {breakdown && <Row label="Other charges (incl taxes)" value={formatPaise(breakdown.otherChargesPaise)} muted />}
          <div className="my-1 border-t border-[var(--color-border)]" />
          <Row label="Total" value={breakdown ? formatPaise(breakdown.totalPaise) : '—'} bold />

          {!appliedCode ? (
            <div className="mt-2 flex items-end gap-2">
              <div className="flex-1"><Input label="Coupon code" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="SUMMER10" /></div>
              <Button variant="secondary" size="sm" onClick={() => applyCode(codeInput)} disabled={!codeInput.trim() || busy}>Apply</Button>
            </div>
          ) : (
            <button type="button" onClick={clearCode} className="mt-1 self-start text-xs font-medium text-[var(--color-text-secondary)] underline">Remove coupon</button>
          )}
          {couponMsg && <p className="text-xs text-red-600">{couponMsg}</p>}

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
                      <span className="text-[var(--color-text-secondary)]">{o.discountType === 'percent' ? `${o.discountValue / 100}% off` : `${formatPaise(o.discountValue)} off`}</span>
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
