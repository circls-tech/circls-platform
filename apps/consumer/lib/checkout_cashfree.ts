/**
 * Cashfree checkout handoff for the consumer portal (INR, when the API routes
 * Indian bookings to Cashfree instead of Razorpay).
 *
 * Mirrors lib/checkout.ts (Razorpay): the API mints a Cashfree order
 * server-side and returns its payment session id (in `clientSecret`) plus the
 * SDK mode ('sandbox' | 'production') in place of a key. We load Cashfree's
 * JS SDK and open its hosted checkout as a pop-up (`redirectTarget: '_modal'`).
 * Capture is confirmed server-side by the webhook, exactly like Razorpay.
 *
 * Unlike Razorpay/Stripe, the SDK's completion callback fires whatever the
 * payment's outcome, so we can't tell "paid" from "failed" in the browser —
 * that result is `{ kind: 'submitted' }`, and the checkout then asks the API
 * (which asks Cashfree) how it went. The pop-up can also be closed after a
 * payment, so a 'dismissed' checkout is checked too.
 *
 * Stub / "payments not enabled" mode: an empty mode or session id resolves
 * `{ kind: 'reserved' }` — the booking row already exists as `pending`.
 */
import type { CheckoutResult } from './checkout';
import { loadScriptOnce } from './load_script';

type CashfreeMode = 'sandbox' | 'production';

interface CashfreeCheckoutResult {
  /** The customer closed the pop-up, or checkout errored before completing. */
  error?: { message?: string };
  /** In-app browsers can't host the pop-up: Cashfree redirects to return_url. */
  redirect?: boolean;
  /** A payment attempt completed — success OR failure. */
  paymentDetails?: { paymentMessage?: string };
}

interface CashfreeInstance {
  checkout: (options: {
    paymentSessionId: string;
    redirectTarget: '_modal';
  }) => Promise<CashfreeCheckoutResult>;
}

declare global {
  interface Window {
    Cashfree?: (options: { mode: CashfreeMode }) => CashfreeInstance;
  }
}

const CASHFREE_SRC = 'https://sdk.cashfree.com/js/v3/cashfree.js';

export interface OpenCashfreeCheckoutInput {
  /** From the API's `keyId`: the SDK mode. Empty in stub mode. */
  mode: string;
  /** From the API's `clientSecret`: the order's payment session id. */
  paymentSessionId: string;
}

/**
 * Opens Cashfree's pop-up checkout and resolves once it closes.
 * - `{ kind: 'reserved' }` if mode/session is empty (stub mode).
 * - `{ kind: 'submitted' }` once a payment attempt completes (or Cashfree
 *   takes over with a redirect) — paid or declined, the API can say.
 * - `{ kind: 'dismissed' }` if the customer closes it without paying.
 */
export async function openCashfreeCheckout(
  input: OpenCashfreeCheckoutInput,
): Promise<CheckoutResult> {
  if (!input.paymentSessionId || (input.mode !== 'sandbox' && input.mode !== 'production')) {
    return { kind: 'reserved' };
  }

  await loadScriptOnce(CASHFREE_SRC, () => Boolean(window.Cashfree), { name: 'Cashfree checkout' });

  const cashfree = window.Cashfree!({ mode: input.mode });
  const result = await cashfree.checkout({
    paymentSessionId: input.paymentSessionId,
    redirectTarget: '_modal',
  });
  if (result.paymentDetails || result.redirect) return { kind: 'submitted' };
  return { kind: 'dismissed' };
}
