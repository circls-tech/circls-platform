'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button, Input, Modal } from '@/lib/ui';
import { formatPaiseExact } from '@/lib/format';
import { openRazorpayCheckout, type CheckoutResult } from '@/lib/checkout';
import { openCashfreeCheckout } from '@/lib/checkout_cashfree';
import { openStripeCheckout } from '@/lib/checkout_stripe';
import {
  fetchCheckoutPaymentStatus,
  fetchPostBookingRedirect,
  switchCheckoutGateway,
  useBookSlots,
  useBookEvent,
  useMyProfile,
  usePurchaseMembership,
} from '@/lib/api/consumer';
import { ApiError } from '@/lib/api/client';
import {
  useCheckoutQuote,
  usePublicCoupons,
  type PublicCouponItem,
  type QuoteRequest,
  type QuoteResponse,
} from '@/lib/api/checkout';
import { useAuth } from '@/lib/firebase/auth_context';
import { PostBookingRedirectPanel } from '@/components/PostBookingRedirect';
import type { PostBookingRedirect } from '@/lib/api/types';
import { ContactDetailsForm } from './ContactDetailsForm';
import { RegistrationQuestionsForm } from './RegistrationQuestionsForm';
import { type RegistrationAnswers, toAnswerPayload } from './answers';
import { pollCheckoutPayment } from './payment_status';
import type { CheckoutItem, CheckoutPrefill } from './types';

type Phase =
  | { kind: 'quoting' } | { kind: 'ready' } | { kind: 'paying' }
  /** Cashfree's pop-up closed: asking the API whether the payment went through. */
  | { kind: 'confirming' }
  /** A Cashfree checkout closed unpaid: try again, or pay through Razorpay. */
  | { kind: 'unpaid'; message: string }
  | { kind: 'success'; message: string } | { kind: 'reserved'; message: string } | { kind: 'error'; message: string };

/** A payment order to open checkout on, as the API returns it. */
interface CheckoutOrder {
  gateway: 'razorpay' | 'stripe' | 'cashfree';
  orderId: string;
  keyId: string;
  clientSecret: string;
  amountPaise: number;
  currency: string;
}

const RESERVED = 'Payments aren’t enabled yet — your booking is reserved.';
const PAID = 'Payment received! See it in My Bookings.';
const PROCESSING = 'Payment submitted! Your booking shows as confirmed in My Bookings once the payment clears.';

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
  // Registration-question answers, keyed by question id. null = the questions
  // step hasn't been completed yet (the gate below shows the form). savedAnswers
  // keeps the entered values so returning to the form (edit / server rejection)
  // doesn't lose them.
  const [answers, setAnswers] = useState<RegistrationAnswers | null>(null);
  const [savedAnswers, setSavedAnswers] = useState<RegistrationAnswers>({});
  const [answersError, setAnswersError] = useState<string | null>(null);
  const eventQuestions = item.kind === 'event' ? (item.questions ?? []) : [];
  // A code handed in by the opener (offers strip on the event page) starts
  // applied; the initial quote validates it like any typed code.
  const initialCode = prefill.couponCode?.trim().toUpperCase() || undefined;
  const [codeInput, setCodeInput] = useState(initialCode ?? '');
  const [appliedCode, setAppliedCode] = useState<string | undefined>(initialCode);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  // The organiser's next step. Free events get it straight from the book call
  // (that booking is already confirmed); paid events must wait for the payment
  // webhook, so it's fetched from the booking once the gateway reports success
  // — the API withholds it while a booking is still 'pending'.
  const [redirect, setRedirect] = useState<PostBookingRedirect | null>(null);
  const [redirectPending, setRedirectPending] = useState(false);

  const offersItem: PublicCouponItem =
    item.kind === 'event' ? { itemType: 'event', itemId: item.eventId }
    : item.kind === 'membership' ? { itemType: 'membership', itemId: item.membershipId }
    : { itemType: 'slot', slotIds: item.slotIds };
  // Load public offers eagerly for every item kind — venue carts included — so
  // the picker dropdown is populated.
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

  // The order being paid, and for events its booking: kept so a Cashfree
  // checkout that closes unpaid can be retried or moved to Razorpay.
  const orderRef = useRef<CheckoutOrder | null>(null);
  const eventBookingIdRef = useRef<string | null>(null);

  async function onPay() {
    if (!breakdown) return;
    setPhase({ kind: 'paying' });
    let order: CheckoutOrder =
      { gateway: 'razorpay', orderId: '', keyId: '', clientSecret: '', amountPaise: breakdown.totalPaise, currency: breakdown.currency ?? 'INR' };
    try {
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
        const answerPayload = toAnswerPayload(eventQuestions, answers);
        const r = await bookEvent.mutateAsync({
          eventId: item.eventId,
          lines: item.lines.map((l) => ({ tierId: l.tierId, quantity: l.quantity })),
          ...(name ? { name } : {}),
          ...(contact ? { contact } : {}),
          ...(appliedCode ? { couponCode: appliedCode } : {}),
          ...(answerPayload.length > 0 ? { answers: answerPayload } : {}),
        });
        // Present only on the free path; paid bookings resolve it after payment.
        setRedirect(r.postBookingRedirect ?? null);
        eventBookingIdRef.current = r.booking?.id ?? null;
        order = { gateway: r.gateway ?? 'razorpay', orderId: r.providerOrderId ?? '', keyId: r.keyId ?? '', clientSecret: r.clientSecret ?? '', amountPaise: r.amountPaise ?? 0, currency: r.currency ?? 'INR' };
      } else {
        const r = await purchaseMembership.mutateAsync({ membershipId: item.membershipId, ...(item.membershipTierId ? { membershipTierId: item.membershipTierId } : {}), ...(appliedCode ? { couponCode: appliedCode } : {}) });
        order = { gateway: r.gateway ?? 'razorpay', orderId: r.orderId ?? '', keyId: r.keyId ?? '', clientSecret: r.clientSecret ?? '', amountPaise: r.amountPaise ?? 0, currency: r.currency ?? 'INR' };
      }

    } catch (e) {
      // A rejected answer is fixable — reopen the questions form (pre-filled)
      // with the server's message instead of dead-ending on the error screen.
      if (
        e instanceof ApiError &&
        (e.code === 'answer_required' ||
          e.code === 'invalid_answer_option' ||
          e.code === 'invalid_answer_shape')
      ) {
        setAnswersError(e.message);
        setAnswers(null);
        setPhase({ kind: 'ready' });
        return;
      }
      const raw = (e as Error).message;
      const message = /sold out/i.test(raw)
        ? 'A ticket tier just sold out — go back and adjust quantities.'
        : raw;
      setPhase({ kind: 'error', message });
      return;
    }

    if (breakdown.totalPaise === 0) { setPhase({ kind: 'success', message: 'Confirmed! See it in My Bookings.' }); return; }
    orderRef.current = order;
    await payOrder(order);
  }

  /** Open `order`'s gateway checkout and show how it ended. */
  async function payOrder(order: CheckoutOrder) {
    setPhase({ kind: 'paying' });
    // Stripe opens from the client secret, Cashfree from its payment session
    // (also carried in clientSecret); Razorpay from the order id. Either way
    // an empty browser key means stub mode → the booking is reserved.
    const canOpen = order.keyId && (order.gateway === 'razorpay' ? order.orderId : order.clientSecret);
    if (!canOpen) { setPhase({ kind: 'reserved', message: RESERVED }); return; }

    let result: CheckoutResult;
    try {
      result = order.gateway === 'stripe'
        ? await openStripeCheckout({
            publishableKey: order.keyId, clientSecret: order.clientSecret,
            payLabel: `Pay ${formatPaiseExact(order.amountPaise, order.currency)}`,
            description: item.title,
          })
        : order.gateway === 'cashfree'
        ? await openCashfreeCheckout({ mode: order.keyId, paymentSessionId: order.clientSecret })
        : await openRazorpayCheckout({
            keyId: order.keyId, orderId: order.orderId, amountPaise: order.amountPaise, currency: order.currency,
            description: item.title,
            prefill: { ...(prefill.name ? { name: prefill.name } : {}), ...(prefill.contact ? { contact: prefill.contact } : {}) },
          });
    } catch (e) {
      // Cashfree's checkout didn't open (say its script failed to load): the
      // customer can try again, or pay through Razorpay instead.
      if (order.gateway === 'cashfree') setPhase({ kind: 'unpaid', message: 'The payment page didn’t open.' });
      else setPhase({ kind: 'error', message: (e as Error).message });
      return;
    }

    if (result.kind === 'reserved') setPhase({ kind: 'reserved', message: RESERVED });
    else if (order.gateway === 'cashfree') await settleCashfree(order, result);
    else if (result.kind === 'paid') onPaid(PAID);
    else setPhase({ kind: 'error', message: 'Payment cancelled. Your slot may be held briefly.' });
  }

  /**
   * Cashfree's pop-up can't tell a paid checkout from a declined one, and can
   * be closed after paying, so ask the API, which asks Cashfree.
   */
  async function settleCashfree(order: CheckoutOrder, result: CheckoutResult) {
    setPhase({ kind: 'confirming' });
    const status = await pollCheckoutPayment(
      () => fetchCheckoutPaymentStatus(order.orderId).then((r) => r.status),
      // A finished attempt gets time to clear; a closed pop-up gets a second
      // look, in case it was closed just as a payment went through.
      result.kind === 'submitted' ? { attempts: 8, intervalMs: 2000 } : { attempts: 2, intervalMs: 1500 },
    );
    if (status === 'paid') onPaid(PAID);
    else if (status === 'expired') setPhase({ kind: 'error', message: 'This checkout has expired. Please book again.' });
    else if (status === 'failed') setPhase({ kind: 'unpaid', message: 'Your payment didn’t go through.' });
    // Still processing (a UPI request awaiting approval, say), even if the
    // pop-up was closed: the booking confirms once it clears, and offering
    // another way to pay now could charge the customer twice.
    else if (status === 'processing' || result.kind === 'submitted') onPaid(PROCESSING);
    else setPhase({ kind: 'unpaid', message: 'Payment not completed.' });
  }

  function onPaid(message: string) {
    setPhase({ kind: 'success', message });
    // The booking only earns its post-booking link once the webhook flips
    // it to confirmed, which usually lands just after this callback.
    const bookingId = eventBookingIdRef.current;
    if (bookingId) {
      setRedirectPending(true);
      void fetchPostBookingRedirect(bookingId)
        .then(setRedirect)
        .finally(() => setRedirectPending(false));
    }
  }

  /** "Try another way to pay": move this checkout from Cashfree to Razorpay. */
  async function onSwitchGateway() {
    const current = orderRef.current;
    if (!current) return;
    setPhase({ kind: 'paying' });
    try {
      const r = await switchCheckoutGateway(current.orderId);
      if (r.outcome === 'paid') { onPaid(PAID); return; }
      const next: CheckoutOrder = { ...r.payment, clientSecret: r.payment.clientSecret ?? '' };
      orderRef.current = next;
      await payOrder(next);
    } catch (e) {
      // The Cashfree payment turned out to be in flight after all.
      if (e instanceof ApiError && e.code === 'payment_in_progress') onPaid(PROCESSING);
      else if (e instanceof ApiError && e.code === 'checkout_expired') setPhase({ kind: 'error', message: e.message });
      else setPhase({ kind: 'unpaid', message: 'We couldn’t switch the payment method.' });
    }
  }

  const busy = phase.kind === 'quoting' || phase.kind === 'paying' || phase.kind === 'confirming';
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

  // Events with registration questions collect the answers before the payment
  // view (after the one-time contact gate). Completing the form stores the
  // answers and drops straight through to payment.
  const needsAnswers = eventQuestions.length > 0 && answers === null;

  return (
    <Modal open onClose={onClose} title="Checkout">
      <p className="mb-4 text-sm text-[var(--color-text-secondary)]">{item.title}</p>
      {phase.kind === 'unpaid' ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-[var(--radius)] border-[2px] border-ink bg-tone-warning-bg px-4 py-3 text-sm font-medium text-tone-warning-text shadow-offset-sm">
            {phase.message} Your booking is held for a few minutes.
          </div>
          <Button onClick={() => { if (orderRef.current) void payOrder(orderRef.current); }}>Try again</Button>
          <Button variant="secondary" onClick={() => void onSwitchGateway()}>Try another way to pay</Button>
        </div>
      ) : !done && needsContactDetails ? (
        <ContactDetailsForm
          initialName={(profile.data?.displayName ?? prefill.name ?? user?.displayName ?? '').trim()}
          initialEmail={(profile.data?.email ?? user?.email ?? '').trim()}
        />
      ) : !done && needsAnswers ? (
        <RegistrationQuestionsForm
          questions={eventQuestions}
          initial={savedAnswers}
          serverError={answersError}
          onSubmit={(a) => {
            setSavedAnswers(a);
            setAnswersError(null);
            setAnswers(a);
          }}
        />
      ) : done ? (
        <div className="flex flex-col gap-4">
          <div className={[
            'rounded-[var(--radius)] border-[2px] border-ink px-4 py-3 text-sm font-medium shadow-offset-sm',
            phase.kind === 'success' ? 'bg-tone-success-bg text-tone-success-text'
              : phase.kind === 'reserved' ? 'bg-tone-warning-bg text-tone-warning-text'
              : 'bg-tone-danger-bg text-tone-danger-text',
          ].join(' ')}>{phase.message}</div>
          {/* Only on a confirmed booking: a 'reserved' booking isn't paid for
              yet, and an error created none at all. */}
          {phase.kind === 'success' && redirect && (
            <PostBookingRedirectPanel redirect={redirect} autoRedirect />
          )}
          {phase.kind === 'success' && !redirect && redirectPending && (
            <p className="text-sm text-[var(--color-text-secondary)]">
              Checking whether the organiser has a next step for you…
            </p>
          )}
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
          {breakdown && (
            <Row
              label={
                (breakdown.platformFeePaise ?? 0) > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    Other charges (incl taxes)
                    <InfoTooltip
                      label="What's included in other charges"
                      lines={[
                        `Payment processing: ${formatPaiseExact(breakdown.gatewayFeePaise ?? 0, cur)}`,
                        `Platform fee: ${formatPaiseExact(breakdown.platformFeePaise ?? 0, cur)}`,
                      ]}
                    />
                  </span>
                ) : (
                  'Other charges (incl taxes)'
                )
              }
              value={formatPaiseExact(breakdown.otherChargesPaise, cur)}
              muted
            />
          )}
          <div className="my-1 border-t-[1.5px] border-dashed border-ink/25" />
          <Row label="Total" value={breakdown ? formatPaiseExact(breakdown.totalPaise, cur) : '—'} bold />

          {eventQuestions.length > 0 && answers !== null && (
            <button
              type="button"
              onClick={() => setAnswers(null)}
              disabled={busy}
              className="self-start text-xs font-medium text-[var(--color-text-secondary)] underline"
            >
              Edit your answers
            </button>
          )}

          {!appliedCode ? (
            <div className="mt-2 flex flex-col gap-2">
              {(offers.data?.rows.length ?? 0) > 0 && (
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
          {phase.kind === 'confirming' && (
            <p className="text-center text-xs text-[var(--color-text-secondary)]">Checking your payment…</p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value, muted, accent, bold }: { label: React.ReactNode; value: string; muted?: boolean; accent?: boolean; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={muted ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-ink)]'}>{label}</span>
      <span className={[accent ? 'text-petal-green' : 'text-[var(--color-ink)]', bold ? 'font-display font-extrabold' : ''].join(' ')}>{value}</span>
    </div>
  );
}

/**
 * Minimal ⓘ tooltip: hover/focus shows the panel; a tap toggles it (mobile has
 * no hover). Absolutely positioned — the modal panel has no overflow-hidden,
 * so it renders over the edge cleanly.
 */
function InfoTooltip({ label, lines }: { label: string; lines: string[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLSpanElement | null>(null);

  // Touch devices open via tap and have no blur/mouseleave to rely on —
  // dismiss on any pointer-down outside the tooltip.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="flex h-4 w-4 items-center justify-center rounded-full border-[1.5px] border-ink/40 text-[10px] font-semibold leading-none text-[var(--color-text-secondary)]"
      >
        i
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute bottom-full left-1/2 z-20 mb-1.5 w-max max-w-[240px] -translate-x-1/2 rounded-[var(--radius)] border-[2px] border-ink bg-white px-3 py-2 text-xs text-[var(--color-ink)] shadow-offset-sm"
        >
          {lines.map((l) => (
            <span key={l} className="block whitespace-nowrap">
              {l}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
