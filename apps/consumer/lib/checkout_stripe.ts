/**
 * Stripe checkout handoff for the consumer portal (US venues).
 *
 * Mirrors lib/checkout.ts (Razorpay): the API mints a PaymentIntent
 * server-side and returns its client secret + our publishable key. We load
 * Stripe.js, mount a Payment Element in a lightweight overlay, and confirm
 * the payment in-page (`redirect: 'if_required'` — card payments never leave
 * the page). Capture is confirmed server-side by the webhook, exactly like
 * Razorpay.
 *
 * Stub / "payments not enabled" mode: an empty publishable key or client
 * secret resolves `{ kind: 'reserved' }` — the booking row already exists as
 * `pending`, same as the Razorpay stub path.
 */
import type { CheckoutResult } from './checkout';

interface StripePaymentElement {
  mount: (el: HTMLElement) => void;
  unmount: () => void;
}

interface StripeElements {
  create: (type: 'payment') => StripePaymentElement;
}

interface StripeInstance {
  elements: (options: {
    clientSecret: string;
    appearance?: { variables?: Record<string, string> };
  }) => StripeElements;
  confirmPayment: (options: {
    elements: StripeElements;
    redirect: 'if_required';
  }) => Promise<{
    error?: { message?: string };
    paymentIntent?: { status: string };
  }>;
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeInstance;
  }
}

const STRIPE_SRC = 'https://js.stripe.com/v3/';

let loadPromise: Promise<void> | null = null;

/** Dynamically inject Stripe.js exactly once. */
function loadStripeScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('not in browser'));
  if (window.Stripe) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${STRIPE_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Stripe')));
      if (window.Stripe) resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = STRIPE_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('Failed to load Stripe.js'));
    };
    document.body.appendChild(script);
  });
  return loadPromise;
}

export interface OpenStripeCheckoutInput {
  publishableKey: string;
  clientSecret: string;
  /** Rendered on the overlay's pay button, e.g. "Pay $12.99". */
  payLabel: string;
  description?: string;
}

/**
 * Opens a Stripe Payment Element overlay and resolves once it closes.
 * - Resolves `{ kind: 'reserved' }` immediately if key/secret is empty
 *   (stub mode) — caller should show "Payment isn't enabled yet".
 * - Resolves `{ kind: 'paid' }` once Stripe confirms the PaymentIntent.
 * - Resolves `{ kind: 'dismissed' }` if the user closes without paying.
 */
export async function openStripeCheckout(input: OpenStripeCheckoutInput): Promise<CheckoutResult> {
  if (!input.publishableKey || !input.clientSecret) return { kind: 'reserved' };

  await loadStripeScript();
  if (!window.Stripe) return { kind: 'reserved' };

  const stripe = window.Stripe(input.publishableKey);
  const elements = stripe.elements({
    clientSecret: input.clientSecret,
    appearance: { variables: { colorPrimary: '#2563eb' } },
  });

  // Overlay DOM — standalone so it works from any page, like Razorpay's own
  // overlay. Styles are inline to avoid coupling to the app stylesheet.
  const backdrop = document.createElement('div');
  backdrop.style.cssText =
    'position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px;';
  const card = document.createElement('div');
  card.style.cssText =
    'background:#fff;border-radius:12px;max-width:420px;width:100%;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.3);font-family:inherit;';
  const heading = document.createElement('div');
  heading.style.cssText =
    'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;';
  const title = document.createElement('strong');
  title.textContent = 'Circls';
  title.style.cssText = 'font-size:16px;color:#0f172a;';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText =
    'border:0;background:none;font-size:16px;cursor:pointer;color:#475569;padding:4px;';
  heading.append(title, closeBtn);

  const desc = document.createElement('p');
  desc.textContent = input.description ?? '';
  desc.style.cssText = 'margin:0 0 12px;font-size:13px;color:#475569;';

  const mountPoint = document.createElement('div');
  const errorLine = document.createElement('p');
  errorLine.style.cssText = 'margin:8px 0 0;font-size:13px;color:#dc2626;min-height:1em;';

  const payBtn = document.createElement('button');
  payBtn.type = 'button';
  payBtn.textContent = input.payLabel;
  payBtn.style.cssText =
    'margin-top:14px;width:100%;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:15px;font-weight:600;padding:12px;cursor:pointer;';

  card.append(heading, desc, mountPoint, errorLine, payBtn);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const paymentElement = elements.create('payment');
  paymentElement.mount(mountPoint);

  return new Promise<CheckoutResult>((resolve) => {
    let settled = false;
    const finish = (r: CheckoutResult) => {
      if (settled) return;
      settled = true;
      paymentElement.unmount();
      backdrop.remove();
      resolve(r);
    };

    closeBtn.onclick = () => finish({ kind: 'dismissed' });
    backdrop.onclick = (e) => {
      if (e.target === backdrop) finish({ kind: 'dismissed' });
    };

    payBtn.onclick = async () => {
      payBtn.disabled = true;
      payBtn.style.opacity = '0.6';
      errorLine.textContent = '';
      try {
        const { error, paymentIntent } = await stripe.confirmPayment({
          elements,
          redirect: 'if_required',
        });
        if (error) {
          errorLine.textContent = error.message ?? 'Payment failed. Try again.';
          payBtn.disabled = false;
          payBtn.style.opacity = '1';
          return;
        }
        // 'processing' also counts: the webhook confirms the booking either
        // way, mirroring how the Razorpay success handler is optimistic.
        if (
          paymentIntent &&
          ['succeeded', 'processing', 'requires_capture'].includes(paymentIntent.status)
        ) {
          finish({ kind: 'paid' });
          return;
        }
        errorLine.textContent = 'Payment not completed. Try again.';
        payBtn.disabled = false;
        payBtn.style.opacity = '1';
      } catch {
        errorLine.textContent = 'Something went wrong. Try again.';
        payBtn.disabled = false;
        payBtn.style.opacity = '1';
      }
    };
  });
}
