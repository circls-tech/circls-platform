/**
 * Razorpay Checkout handoff for the consumer portal.
 *
 * The API mints a Razorpay order server-side and returns its id. To collect
 * payment we open the hosted Razorpay Checkout overlay in the browser, which
 * needs the order id + the public key id.
 *
 * Stub / "payments not enabled" mode: when live Razorpay keys aren't configured
 * the API returns an EMPTY keyId (slot bookings) or simply no order (events /
 * memberships that are pending payment). In those cases we must NOT try to open
 * Razorpay — the booking row already exists as `pending` and will be reconciled
 * once payments go live. We surface a friendly "reserved" message instead.
 *
 * Free items (amountPaise 0, or an event/membership that comes back confirmed
 * with no order) skip this module entirely.
 */

interface RazorpayHandler {
  (response: {
    razorpay_payment_id?: string;
    razorpay_order_id?: string;
    razorpay_signature?: string;
  }): void;
}

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  handler: RazorpayHandler;
  prefill?: { name?: string; contact?: string; email?: string };
  theme?: { color?: string };
  modal?: { ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

let loadPromise: Promise<void> | null = null;

/** Dynamically inject the Razorpay Checkout script exactly once. */
function loadRazorpayScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('not in browser'));
  if (window.Razorpay) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Razorpay')));
      if (window.Razorpay) resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('Failed to load Razorpay Checkout'));
    };
    document.body.appendChild(script);
  });
  return loadPromise;
}

export type CheckoutResult =
  | { kind: 'paid' }
  | { kind: 'dismissed' }
  /** keyId/order missing — payments not enabled; booking is reserved as pending. */
  | { kind: 'reserved' };

export interface OpenCheckoutInput {
  keyId: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  description?: string;
  prefill?: { name?: string; contact?: string };
}

/**
 * Opens Razorpay Checkout and resolves once the overlay closes.
 * - Resolves `{ kind: 'reserved' }` immediately if keyId/orderId is empty
 *   (stub mode) — caller should show "Payment isn't enabled yet".
 * - Resolves `{ kind: 'paid' }` from the success handler.
 * - Resolves `{ kind: 'dismissed' }` if the user closes without paying.
 */
export async function openRazorpayCheckout(input: OpenCheckoutInput): Promise<CheckoutResult> {
  if (!input.keyId || !input.orderId) return { kind: 'reserved' };

  await loadRazorpayScript();
  if (!window.Razorpay) return { kind: 'reserved' };

  return new Promise<CheckoutResult>((resolve) => {
    let settled = false;
    const finish = (r: CheckoutResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const options: RazorpayOptions = {
      key: input.keyId,
      order_id: input.orderId,
      amount: input.amountPaise,
      currency: input.currency,
      name: 'Circls',
      handler: () => finish({ kind: 'paid' }),
      modal: { ondismiss: () => finish({ kind: 'dismissed' }) },
      theme: { color: '#2563eb' },
    };
    if (input.description) options.description = input.description;
    if (input.prefill) {
      const prefill: NonNullable<RazorpayOptions['prefill']> = {};
      if (input.prefill.name) prefill.name = input.prefill.name;
      if (input.prefill.contact) prefill.contact = input.prefill.contact;
      options.prefill = prefill;
    }

    const rzp = new window.Razorpay!(options);
    rzp.open();
  });
}
