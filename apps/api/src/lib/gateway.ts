/**
 * Payment gateway port — the provider-agnostic contract every gateway adapter
 * implements (Razorpay today; Stripe next). Services resolve an adapter via
 * `getGateway()` instead of importing a provider module directly, so adding a
 * gateway is a new adapter + a `providerForCountry` mapping, not a service
 * rewrite.
 *
 * Amounts are in the currency's minor unit (paise for INR, cents for USD).
 * The `*_paise` DB columns store minor units of the row's `currency` — the
 * column name predates multi-currency.
 */
import { env } from '../config/env.js';
import { getRazorpay } from './razorpay.js';
import { getStripe } from './stripe.js';

export type GatewayMode = 'stub' | 'live';

/**
 * Gateways money can move through. Mirrors the `payment_provider` DB enum
 * minus its non-gateway values ('stub', 'external').
 */
export type PaymentProviderId = 'razorpay' | 'stripe';

export interface CreateOrderInput {
  /** Total to charge the customer, in the currency's minor unit. */
  amountMinor: number;
  /** ISO 4217, e.g. 'INR' | 'USD'. */
  currency: string;
  /** Our booking id — surfaces in the gateway dashboard for reconciliation. */
  reference: string;
  notes?: Record<string, string> | undefined;
}

export interface GatewayOrder {
  id: string;
  status: 'created' | 'attempted' | 'paid';
  amountMinor: number;
  /**
   * Stripe only: the PaymentIntent client secret the browser needs to confirm
   * the payment (Razorpay's checkout needs only the order id + key id).
   */
  clientSecret?: string | undefined;
}

export interface GatewayRefundInput {
  /** The gateway's payment id the refund is issued against. */
  paymentId: string;
  amountMinor: number;
  reason?: string | undefined;
  reference: string;
}

export interface GatewayRefundResult {
  id: string;
  status: 'pending' | 'processed' | 'failed';
  amountMinor: number;
}

export interface PaymentGateway {
  readonly provider: PaymentProviderId;
  readonly mode: GatewayMode;
  createOrder(input: CreateOrderInput): Promise<GatewayOrder>;
  /**
   * Cancel an unpaid order so the customer can no longer complete payment
   * against it (a Stripe PaymentIntent stays confirmable — and a Razorpay
   * order payable — after failed attempts). Called when we cancel a booking
   * whose charge was never captured. Best-effort: adapters throw on API
   * errors and callers log-and-continue; a cancel that loses the race against
   * a capture is absorbed by the capture-after-cancel auto-refund safety net
   * in payments_service. Razorpay has no order-cancel API — its adapter is a
   * documented no-op.
   */
  cancelOrder(orderId: string): Promise<void>;
  refundPayment(input: GatewayRefundInput): Promise<GatewayRefundResult>;
  /** HMAC verify of a gateway webhook over the exact raw body bytes. */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

export function getGateway(provider: PaymentProviderId): PaymentGateway {
  switch (provider) {
    case 'razorpay':
      return getRazorpay();
    case 'stripe':
      return getStripe();
  }
}

/**
 * The venue country dropdown stores display names ('India' | 'USA'); the
 * tenant profile is free text. Normalize the common US spellings.
 */
export function isUsCountry(country: string | null | undefined): boolean {
  if (!country) return false;
  const c = country.trim().toUpperCase();
  return c === 'US' || c === 'USA' || c === 'UNITED STATES' || c === 'UNITED STATES OF AMERICA';
}

/**
 * Which gateway settles a venue's money, keyed by the venue's country
 * (callers fall back to the tenant's country when the venue has none). The
 * gateway follows where the money settles — a US traveller booking a Mumbai
 * venue still pays in INR via Razorpay.
 */
export function providerForCountry(country: string | null | undefined): PaymentProviderId {
  return isUsCountry(country) ? 'stripe' : 'razorpay';
}

/** The currency a venue's prices are denominated in, keyed like the provider. */
export function currencyForCountry(country: string | null | undefined): 'USD' | 'INR' {
  return isUsCountry(country) ? 'USD' : 'INR';
}

/**
 * The public (browser-safe) key checkout needs for a gateway. Empty string in
 * stub mode — the consumer app reads that as "payments not enabled" and shows
 * the booking as reserved.
 */
export function publicKeyIdFor(provider: PaymentProviderId): string {
  return (provider === 'stripe' ? env.STRIPE_PUBLISHABLE_KEY : env.RAZORPAY_KEY_ID) ?? '';
}
