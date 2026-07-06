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
import { getRazorpay } from './razorpay.js';

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
  refundPayment(input: GatewayRefundInput): Promise<GatewayRefundResult>;
  /** HMAC verify of a gateway webhook over the exact raw body bytes. */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

export function getGateway(provider: PaymentProviderId): PaymentGateway {
  switch (provider) {
    case 'razorpay':
      return getRazorpay();
    case 'stripe':
      // Callers map 'not implemented' onto a payment_not_available Conflict.
      throw new Error('Stripe gateway not implemented');
  }
}

/**
 * Which gateway settles a venue's money, keyed by the venue's country
 * (ISO 3166-1 alpha-2; callers fall back to the tenant's country when the
 * venue has none). The gateway follows where the money settles — a US
 * traveller booking a Mumbai venue still pays in INR via Razorpay.
 *
 * Everything maps to Razorpay until the Stripe adapter ships; then 'US'
 * flips to 'stripe'.
 */
export function providerForCountry(_country: string | null | undefined): PaymentProviderId {
  return 'razorpay';
}
