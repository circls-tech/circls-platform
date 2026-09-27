/**
 * Payment gateway port — the provider-agnostic contract every gateway adapter
 * implements (Razorpay and Cashfree for INR, Stripe for USD). Services resolve an adapter via
 * `getGateway()` instead of importing a provider module directly, so adding a
 * gateway is a new adapter + a `providerForCountry` mapping, not a service
 * rewrite.
 *
 * Amounts are in the currency's minor unit (paise for INR, cents for USD).
 * The `*_paise` DB columns store minor units of the row's `currency` — the
 * column name predates multi-currency.
 */
import { env } from '../config/env.js';
import { getCashfree } from './cashfree.js';
import { getRazorpay } from './razorpay.js';
import { getStripe } from './stripe.js';

export type GatewayMode = 'stub' | 'live';

/**
 * Gateways money can move through. Mirrors the `payment_provider` DB enum
 * minus its non-gateway values ('stub', 'external').
 */
export type PaymentProviderId = 'razorpay' | 'stripe' | 'cashfree';

const GATEWAY_PROVIDERS: readonly PaymentProviderId[] = ['razorpay', 'stripe', 'cashfree'];

/**
 * True for a `payment_provider` value that is a real gateway (as opposed to
 * 'stub' or 'external'). Use this instead of listing gateways inline, so a new
 * gateway can't be silently skipped by cancel/refund paths.
 */
export function isGatewayProvider(provider: string | null | undefined): provider is PaymentProviderId {
  return GATEWAY_PROVIDERS.includes(provider as PaymentProviderId);
}

export interface CreateOrderInput {
  /** Total to charge the customer, in the currency's minor unit. */
  amountMinor: number;
  /** ISO 4217, e.g. 'INR' | 'USD'. */
  currency: string;
  /** Our booking id — surfaces in the gateway dashboard for reconciliation. */
  reference: string;
  /**
   * Our payments row id — unique per order attempt (a booking can mint more
   * than one order). Gateways that take a merchant-chosen order id (Cashfree)
   * use it; the others generate their own.
   */
  chargeId: string;
  /** The paying customer, for gateways that require customer details (Cashfree). */
  customer?: GatewayCustomer | undefined;
  notes?: Record<string, string> | undefined;
}

export interface GatewayCustomer {
  /** Stable id for the customer — the user id, else the booking id. */
  id: string;
  phoneE164?: string | null | undefined;
  email?: string | null | undefined;
  name?: string | null | undefined;
}

export interface GatewayOrder {
  id: string;
  status: 'created' | 'attempted' | 'paid';
  amountMinor: number;
  /**
   * What the browser needs to open checkout beyond the order id: the Stripe
   * PaymentIntent client secret, or the Cashfree payment session id.
   * Razorpay's checkout needs only the order id + key id.
   */
  clientSecret?: string | undefined;
}

export interface GatewayRefundInput {
  /** The gateway's payment id the refund is issued against. */
  paymentId: string;
  /** The gateway order id the payment belongs to (Cashfree refunds by order). */
  orderId?: string | null | undefined;
  /** Our refund ledger row id — the merchant refund id where a gateway takes one. */
  refundId: string;
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
  /**
   * HMAC verify of a gateway webhook over the exact raw body bytes.
   * `timestamp` is the separate timestamp header for gateways that sign it
   * alongside the body (Cashfree's `x-webhook-timestamp`); Stripe carries its
   * timestamp inside the signature header and Razorpay signs none.
   */
  verifyWebhookSignature(rawBody: string, signature: string, timestamp?: string): boolean;
}

export function getGateway(provider: PaymentProviderId): PaymentGateway {
  switch (provider) {
    case 'razorpay':
      return getRazorpay();
    case 'stripe':
      return getStripe();
    case 'cashfree':
      return getCashfree();
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
 * venue still pays in INR. INR orders go through `INR_PAYMENT_GATEWAY`
 * (Razorpay or Cashfree); switching it only affects NEW orders — refunds,
 * cancels and webhooks always use the provider recorded on the charge row.
 */
export function providerForCountry(country: string | null | undefined): PaymentProviderId {
  return isUsCountry(country) ? 'stripe' : env.INR_PAYMENT_GATEWAY;
}

/** The currency a venue's prices are denominated in, keyed like the provider. */
export function currencyForCountry(country: string | null | undefined): 'USD' | 'INR' {
  return isUsCountry(country) ? 'USD' : 'INR';
}

/**
 * The public (browser-safe) key checkout needs for a gateway. Empty string in
 * stub mode — the consumer app reads that as "payments not enabled" and shows
 * the booking as reserved. Cashfree's JS SDK takes no key, only the
 * environment, so its "key" is the SDK mode ('sandbox' | 'production').
 */
export function publicKeyIdFor(provider: PaymentProviderId): string {
  switch (provider) {
    case 'stripe':
      return env.STRIPE_PUBLISHABLE_KEY ?? '';
    case 'razorpay':
      return env.RAZORPAY_KEY_ID ?? '';
    case 'cashfree':
      return getCashfree().mode === 'live' ? env.CASHFREE_ENV : '';
  }
}
