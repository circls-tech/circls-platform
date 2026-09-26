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
 * that result is `{ kind: 'submitted' }` and the webhook decides.
 *
 * Stub / "payments not enabled" mode: an empty mode or session id resolves
 * `{ kind: 'reserved' }` — the booking row already exists as `pending`.
 */
import type { CheckoutResult } from './checkout';

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

let loadPromise: Promise<void> | null = null;

/** Dynamically inject the Cashfree JS SDK exactly once. */
function loadCashfreeScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('not in browser'));
  if (window.Cashfree) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CASHFREE_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Cashfree')));
      if (window.Cashfree) resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = CASHFREE_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('Failed to load Cashfree checkout'));
    };
    document.body.appendChild(script);
  });
  return loadPromise;
}

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
 *   takes over with a redirect) — the webhook confirms the booking.
 * - `{ kind: 'dismissed' }` if the customer closes it without paying.
 */
export async function openCashfreeCheckout(
  input: OpenCashfreeCheckoutInput,
): Promise<CheckoutResult> {
  if (!input.paymentSessionId || (input.mode !== 'sandbox' && input.mode !== 'production')) {
    return { kind: 'reserved' };
  }

  await loadCashfreeScript();
  if (!window.Cashfree) return { kind: 'reserved' };

  const cashfree = window.Cashfree({ mode: input.mode });
  const result = await cashfree.checkout({
    paymentSessionId: input.paymentSessionId,
    redirectTarget: '_modal',
  });
  if (result.paymentDetails || result.redirect) return { kind: 'submitted' };
  return { kind: 'dismissed' };
}
