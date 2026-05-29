'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import {
  useBookEvent,
  useBookSlots,
  usePurchaseMembership,
} from '@/lib/api/consumer';
import { openRazorpayCheckout } from '@/lib/checkout';
import { useAuth } from '@/lib/firebase/auth_context';

const RAZORPAY_KEY_ID = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? '';

export type CheckoutState =
  | { kind: 'idle' }
  | { kind: 'success'; message: string }
  | { kind: 'reserved'; message: string }
  | { kind: 'error'; message: string };

/**
 * Drives the consumer book/purchase + Razorpay flow for all three item types.
 * Handles: redirect-to-login when signed out, the empty-keyId / stub case, and
 * free items. Exposes per-action helpers plus a shared `state` + `busy` flag.
 */
export function useCheckout() {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const bookSlots = useBookSlots();
  const bookEvent = useBookEvent();
  const purchaseMembership = usePurchaseMembership();

  const [state, setState] = useState<CheckoutState>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  /** Returns true if signed in; otherwise redirects to login and returns false. */
  const ensureSignedIn = useCallback((): boolean => {
    if (user) return true;
    const target = pathname ?? '/';
    router.push(`/login?redirect=${encodeURIComponent(target)}`);
    return false;
  }, [user, router, pathname]);

  const reset = useCallback(() => setState({ kind: 'idle' }), []);

  const errMsg = (e: unknown) =>
    e instanceof Error ? e.message : 'Something went wrong. Please try again.';

  const bookSlotsNow = useCallback(
    async (input: { slotIds: string[]; customerName: string; customerContact: string; note?: string }) => {
      if (!ensureSignedIn()) return;
      setBusy(true);
      setState({ kind: 'idle' });
      try {
        const body: { slotIds: string[]; customerName: string; customerContact: string; note?: string } = {
          slotIds: input.slotIds,
          customerName: input.customerName,
          customerContact: input.customerContact,
        };
        if (input.note) body.note = input.note;
        const res = await bookSlots.mutateAsync(body);
        const { orderId, keyId, amountPaise, currency } = res.payment;

        if (amountPaise === 0) {
          setState({ kind: 'success', message: 'Booking confirmed!' });
          return;
        }
        const result = await openRazorpayCheckout({
          keyId,
          orderId,
          amountPaise,
          currency,
          description: 'Court booking',
          prefill: { name: input.customerName, contact: input.customerContact },
        });
        if (result.kind === 'paid') setState({ kind: 'success', message: 'Payment successful — booking confirmed!' });
        else if (result.kind === 'reserved') setState({ kind: 'reserved', message: "Payment isn't enabled yet — your booking is reserved." });
        else setState({ kind: 'idle' });
      } catch (e) {
        setState({ kind: 'error', message: errMsg(e) });
      } finally {
        setBusy(false);
      }
    },
    [ensureSignedIn, bookSlots],
  );

  const bookEventNow = useCallback(
    async (eventId: string, amountPaise: number, prefill?: { name?: string; contact?: string }) => {
      if (!ensureSignedIn()) return;
      setBusy(true);
      setState({ kind: 'idle' });
      try {
        const res = await bookEvent.mutateAsync({ eventId });
        // Free events come back confirmed with no order.
        if (!res.providerOrderId || amountPaise === 0) {
          setState({ kind: 'success', message: 'You\'re registered!' });
          return;
        }
        const result = await openRazorpayCheckout({
          keyId: res.keyId || RAZORPAY_KEY_ID,
          orderId: res.providerOrderId,
          amountPaise: res.amountPaise ?? amountPaise,
          currency: 'INR',
          description: 'Event registration',
          ...(prefill ? { prefill } : {}),
        });
        if (result.kind === 'paid') setState({ kind: 'success', message: 'Payment successful — you\'re registered!' });
        else if (result.kind === 'reserved') setState({ kind: 'reserved', message: "Payment isn't enabled yet — your spot is reserved." });
        else setState({ kind: 'idle' });
      } catch (e) {
        setState({ kind: 'error', message: errMsg(e) });
      } finally {
        setBusy(false);
      }
    },
    [ensureSignedIn, bookEvent],
  );

  const buyMembershipNow = useCallback(
    async (membershipId: string, amountPaise: number, prefill?: { name?: string; contact?: string }) => {
      if (!ensureSignedIn()) return;
      setBusy(true);
      setState({ kind: 'idle' });
      try {
        const res = await purchaseMembership.mutateAsync(membershipId);
        // Free memberships activate immediately with no order.
        if (!res.orderId || amountPaise === 0) {
          setState({ kind: 'success', message: 'Membership activated!' });
          return;
        }
        const result = await openRazorpayCheckout({
          keyId: res.keyId || RAZORPAY_KEY_ID,
          orderId: res.orderId,
          amountPaise: res.amountPaise ?? amountPaise,
          currency: 'INR',
          description: 'Membership',
          ...(prefill ? { prefill } : {}),
        });
        if (result.kind === 'paid') setState({ kind: 'success', message: 'Payment successful — membership activated!' });
        else if (result.kind === 'reserved') setState({ kind: 'reserved', message: "Payment isn't enabled yet — your membership is reserved." });
        else setState({ kind: 'idle' });
      } catch (e) {
        setState({ kind: 'error', message: errMsg(e) });
      } finally {
        setBusy(false);
      }
    },
    [ensureSignedIn, purchaseMembership],
  );

  return { state, busy, reset, bookSlotsNow, bookEventNow, buyMembershipNow };
}
