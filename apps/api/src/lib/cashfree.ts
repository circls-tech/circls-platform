/**
 * Cashfree gateway adapter (INR, an alternative to Razorpay — which INR
 * gateway takes new orders is `INR_PAYMENT_GATEWAY`, see gateway.ts).
 *
 * Implements the provider-agnostic `PaymentGateway` port. Circls is the
 * merchant — a plain order per booking, no Easy Split:
 *   1. `POST /orders`                  — order for online booking. We choose
 *      the order id (our payments row id); the returned `payment_session_id`
 *      is handed to the browser, which opens Cashfree's JS checkout with it.
 *      Capture is then reported via webhook.
 *   2. `PATCH /orders/{id}`            — terminate an unpaid order.
 *   3. `POST /orders/{id}/refunds`     — refunds (by order, not payment id).
 *
 * Amounts: Cashfree takes and reports rupees as decimals (10.15 = ₹10.15);
 * everything on our side is paise, so we convert at this boundary only.
 *
 * Webhook signature: base64(HMAC-SHA256(x-webhook-timestamp + rawBody)) under
 * the client secret, sent in `x-webhook-signature`.
 *
 * When `CASHFREE_CLIENT_*` env is absent the stub adapter returns
 * deterministic ids prefixed `stub_` so tests can assert on shape without
 * network — mirrors the Razorpay and Stripe stubs.
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { gatewayRequest } from './gateway_http.js';
import { logger } from './logger.js';
import type {
  CreateOrderInput,
  GatewayCustomer,
  GatewayOrder,
  GatewayOrderStatus,
  GatewayRefundInput,
  GatewayRefundResult,
  PaymentGateway,
} from './gateway.js';

/** API version header. Webhook payload version is set in the Cashfree dashboard. */
export const CASHFREE_API_VERSION = '2026-01-01';

/** Paise → the rupee decimal Cashfree expects (2 dp). */
export function minorToCashfreeAmount(amountMinor: number): number {
  return Math.round(amountMinor) / 100;
}

/** A rupee decimal from Cashfree (order/payment/refund amount) → paise. */
export function cashfreeAmountToMinor(amount: number): number {
  return Math.round(amount * 100);
}

/** Cashfree ids (customer_id, refund_id) accept alphanumerics only. */
function alphanumeric(value: string, maxLength: number): string {
  return value.replace(/[^A-Za-z0-9]/g, '').slice(0, maxLength);
}

/**
 * Cashfree requires a phone on every order: 10 digits for India, or a
 * '+'-prefixed international number. Customers without a phone on file get
 * a placeholder — Cashfree documents dummy details as acceptable, and the
 * payer enters their real UPI/card details on the hosted checkout anyway.
 */
const PLACEHOLDER_PHONE = '9999999999';

function cashfreePhone(phoneE164: string | null | undefined): string {
  if (!phoneE164) return PLACEHOLDER_PHONE;
  const digits = phoneE164.replace(/[^0-9]/g, '');
  if (phoneE164.startsWith('+91') && digits.length === 12) return digits.slice(2);
  if (phoneE164.startsWith('+') && digits.length >= 8) return `+${digits}`;
  if (digits.length === 10) return digits;
  return PLACEHOLDER_PHONE;
}

/** Optional text fields Cashfree bounds at 3..100 chars — omit rather than fail. */
function boundedText(value: string | null | undefined, max = 100): string | undefined {
  const v = value?.trim();
  if (!v || v.length < 3) return undefined;
  return v.slice(0, max);
}

function customerDetails(customer: GatewayCustomer | undefined, fallbackId: string) {
  const id = alphanumeric(customer?.id ?? fallbackId, 50);
  const email = boundedText(customer?.email);
  const name = boundedText(customer?.name);
  return {
    customer_id: id.length >= 3 ? id : alphanumeric(fallbackId, 50),
    customer_phone: cashfreePhone(customer?.phoneE164),
    ...(email ? { customer_email: email } : {}),
    ...(name ? { customer_name: name } : {}),
  };
}

// ── Stub adapter ────────────────────────────────────────────────────────────
let stubCounter = 0;
const nextStubId = (prefix: string): string => `stub_${prefix}_${++stubCounter}`;
let stubCancelledOrders: string[] = [];

/**
 * A stub adapter in production means the keys were removed while real
 * Cashfree charges still exist (charges created in stub mode are stored as
 * provider 'stub' and never reach here). Faking a refund or cancel then would
 * mark money returned that never moved — fail loudly instead.
 */
function assertStubMayMoveMoney(op: string): void {
  if (env.NODE_ENV === 'production') {
    throw new Error(`Cashfree is not configured — cannot ${op} (payments_unconfigured)`);
  }
}

class StubCashfree implements PaymentGateway {
  readonly provider = 'cashfree' as const;
  readonly mode = 'stub' as const;

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const id = nextStubId('cforder');
    return {
      id,
      status: 'created',
      amountMinor: input.amountMinor,
      clientSecret: `${id}_session`,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    assertStubMayMoveMoney('cancelOrder');
    stubCancelledOrders.push(orderId);
  }

  async refundPayment(input: GatewayRefundInput): Promise<GatewayRefundResult> {
    assertStubMayMoveMoney('refundPayment');
    return { id: nextStubId('cfrefund'), status: 'processed', amountMinor: input.amountMinor };
  }

  // Stub orders are never paid and stub refunds settle instantly.
  async fetchOrderStatus(_orderId: string, _opts?: { lastAttempt?: boolean }): Promise<GatewayOrderStatus> {
    return { state: 'open' };
  }

  async fetchRefundStatus(_input: { orderId: string; refundId: string }): Promise<GatewayRefundResult> {
    return { id: nextStubId('cfrefund'), status: 'processed', amountMinor: 0 };
  }

  verifyWebhookSignature(_rawBody: string, _signature: string, _timestamp?: string): boolean {
    // In stub mode we accept anything — tests should override if they care.
    return true;
  }
}

// ── Live adapter ────────────────────────────────────────────────────────────
const CASHFREE_API: Record<'sandbox' | 'production', string> = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  production: 'https://api.cashfree.com/pg',
};

interface CashfreeOrderEntity {
  order_id: string;
  order_status: string;
  order_amount: number;
  payment_session_id?: string;
}

interface CashfreePaymentEntity {
  cf_payment_id: string | number;
  payment_status: string;
  payment_time?: string;
}

/** An order's most recent payment attempt (the list's order isn't documented). */
function latestAttempt(list: CashfreePaymentEntity[]): CashfreePaymentEntity | undefined {
  const at = (p: CashfreePaymentEntity) => Date.parse(p.payment_time ?? '') || 0;
  let latest: CashfreePaymentEntity | undefined;
  for (const p of list) if (!latest || at(p) >= at(latest)) latest = p;
  return latest;
}

/**
 * An attempt on a still-open order: declined or abandoned ones can be retried.
 * Anything else, including a status we don't know, counts as still processing
 * — better to keep a customer waiting than to invite a second payment.
 */
function attemptState(status: string): 'pending' | 'failed' {
  return ['FAILED', 'USER_DROPPED', 'CANCELLED', 'VOID'].includes(status) ? 'failed' : 'pending';
}

class LiveCashfree implements PaymentGateway {
  readonly provider = 'cashfree' as const;
  readonly mode = 'live' as const;
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly baseUrl: string,
  ) {}

  private async call<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<T> {
    return gatewayRequest<T>({
      provider: 'cashfree',
      label: 'Cashfree',
      method,
      baseUrl: this.baseUrl,
      path,
      headers: {
        'x-client-id': this.clientId,
        'x-client-secret': this.clientSecret,
        'x-api-version': CASHFREE_API_VERSION,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      errorMessage: (b) => (b as { message?: string }).message,
    });
  }

  // https://www.cashfree.com/docs/api-reference/payments/latest/orders/create-order
  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    // Only used when the checkout can't stay in the modal (in-app browsers):
    // Cashfree then redirects here after payment. Must be https.
    const returnUrl = `${env.CONSUMER_BASE_URL.replace(/\/$/, '')}/me/bookings`;
    const order = await this.call<CashfreeOrderEntity>('POST', '/orders', {
      order_id: input.chargeId,
      order_amount: minorToCashfreeAmount(input.amountMinor),
      order_currency: input.currency,
      customer_details: customerDetails(input.customer, input.reference),
      ...(returnUrl.startsWith('https://') ? { order_meta: { return_url: returnUrl } } : {}),
      order_tags: { booking_id: input.reference, ...(input.notes ?? {}) },
    });
    if (!order.payment_session_id) {
      throw new Error(`Cashfree /orders returned no payment_session_id for ${order.order_id}`);
    }
    const status: GatewayOrder['status'] = order.order_status === 'PAID' ? 'paid' : 'created';
    return {
      id: order.order_id,
      status,
      amountMinor: cashfreeAmountToMinor(Number(order.order_amount)),
      clientSecret: order.payment_session_id,
    };
  }

  // https://www.cashfree.com/docs/api-reference/payments/latest/orders/terminate-order
  // Termination is asynchronous (TERMINATION_REQUESTED) and is refused when a
  // transaction already succeeded — i.e. we lost the race against a capture.
  // We throw on anything but a terminated/terminating order; callers treat
  // cancelOrder as best-effort and the capture webhook's auto-refund safety
  // net settles a capture that still lands.
  async cancelOrder(orderId: string): Promise<void> {
    const order = await this.call<CashfreeOrderEntity>(
      'PATCH',
      `/orders/${encodeURIComponent(orderId)}`,
      { order_status: 'TERMINATED' },
    );
    if (order.order_status !== 'TERMINATED' && order.order_status !== 'TERMINATION_REQUESTED') {
      throw new Error(`Cashfree order ${orderId} not terminated (status ${order.order_status})`);
    }
  }

  // https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create-refund
  // Cashfree refunds by ORDER id (its orders carry at most one successful
  // payment). `input.refundId` is refund_service's key for this refund, the
  // same on every retry of it, so it serves as both the merchant refund_id
  // and the x-idempotency-key: a retry after a lost response gets the
  // original refund back instead of creating a second one.
  async refundPayment(input: GatewayRefundInput): Promise<GatewayRefundResult> {
    if (!input.orderId) {
      throw new Error(`Cashfree refund for payment ${input.paymentId} needs the order id`);
    }
    const note = boundedText(input.reason);
    const refund = await this.call<CashfreeRefundEntity>(
      'POST',
      `/orders/${encodeURIComponent(input.orderId)}/refunds`,
      {
        refund_amount: minorToCashfreeAmount(input.amountMinor),
        refund_id: cashfreeRefundId(input.refundId),
        ...(note ? { refund_note: note } : {}),
      },
      input.refundId,
    );
    return refundResult(refund);
  }

  // https://www.cashfree.com/docs/api-reference/payments/latest/orders/get-order
  // A PAID order's successful payment comes from its payments list. The
  // amount reported is the order amount we set, not the payer's amount.
  async fetchOrderStatus(orderId: string, opts?: { lastAttempt?: boolean }): Promise<GatewayOrderStatus> {
    const path = `/orders/${encodeURIComponent(orderId)}`;
    const order = await this.call<CashfreeOrderEntity & { order_currency?: string }>('GET', path);
    if (order.order_status !== 'ACTIVE' && order.order_status !== 'PAID') return { state: 'closed' };
    if (order.order_status === 'ACTIVE' && !opts?.lastAttempt) return { state: 'open' };
    const list = await this.call<CashfreePaymentEntity[]>('GET', `${path}/payments`);
    if (order.order_status === 'ACTIVE') {
      const latest = latestAttempt(list);
      return { state: 'open', ...(latest ? { lastAttempt: attemptState(latest.payment_status) } : {}) };
    }
    const paid = list.find((p) => p.payment_status === 'SUCCESS');
    return {
      state: 'paid',
      ...(paid
        ? {
            payment: {
              id: String(paid.cf_payment_id),
              amountMinor: cashfreeAmountToMinor(Number(order.order_amount)),
              currency: order.order_currency ?? 'INR',
            },
          }
        : {}),
    };
  }

  // https://www.cashfree.com/docs/api-reference/payments/latest/refunds/get-refund
  async fetchRefundStatus(input: { orderId: string; refundId: string }): Promise<GatewayRefundResult> {
    const orderPath = `/orders/${encodeURIComponent(input.orderId)}`;
    const refund = await this.call<CashfreeRefundEntity>(
      'GET',
      `${orderPath}/refunds/${encodeURIComponent(cashfreeRefundId(input.refundId))}`,
    );
    return refundResult(refund);
  }

  // https://www.cashfree.com/docs/api-reference/webhooks/payloads-and-signatures
  // No replay window: Cashfree's retry policy re-delivers for up to ~30 min
  // and doesn't document whether retries are re-signed, so a tight window
  // could reject genuine retries. Replays are harmless — every apply* core is
  // idempotent on the payments row state.
  verifyWebhookSignature(rawBody: string, signature: string, timestamp?: string): boolean {
    if (!timestamp) return false;
    const expected = crypto
      .createHmac('sha256', this.clientSecret)
      .update(timestamp + rawBody)
      .digest();
    const received = Buffer.from(signature, 'base64');
    if (expected.length !== received.length) return false;
    return crypto.timingSafeEqual(expected, received);
  }
}

interface CashfreeRefundEntity {
  cf_refund_id: string | number;
  refund_status: string;
  refund_amount: number;
}

function refundResult(refund: CashfreeRefundEntity): GatewayRefundResult {
  return {
    id: String(refund.cf_refund_id),
    status: mapCashfreeRefundStatus(refund.refund_status),
    amountMinor: cashfreeAmountToMinor(Number(refund.refund_amount)),
  };
}

/** A refund key as a Cashfree refund_id (alphanumeric, at most 40 chars). */
export function cashfreeRefundId(refundKey: string): string {
  return alphanumeric(refundKey, 40);
}

/** Cashfree refund status → our gateway refund status. */
export function mapCashfreeRefundStatus(status: string | undefined): GatewayRefundResult['status'] {
  if (status === 'SUCCESS') return 'processed';
  if (status === 'CANCELLED' || status === 'REJECTED') return 'failed';
  // PENDING, PENDING_APPROVAL, ONHOLD — money hasn't moved yet.
  return 'pending';
}

let cached: PaymentGateway | undefined;

export function getCashfree(): PaymentGateway {
  if (cached) return cached;
  const haveClientId = Boolean(env.CASHFREE_CLIENT_ID);
  const haveClientSecret = Boolean(env.CASHFREE_CLIENT_SECRET);

  if (haveClientId && haveClientSecret) {
    cached = new LiveCashfree(
      env.CASHFREE_CLIENT_ID!,
      env.CASHFREE_CLIENT_SECRET!,
      CASHFREE_API[env.CASHFREE_ENV],
    );
    logger.info({ cashfreeEnv: env.CASHFREE_ENV }, 'cashfree_mode_live');
  } else {
    // The client secret also verifies webhooks, so there is no partial config
    // that could charge without being able to confirm — but a lone key is
    // still a misconfiguration worth shouting about.
    if (haveClientId || haveClientSecret) {
      logger.error({ haveClientId, haveClientSecret }, 'cashfree_partially_configured_using_stub');
    } else {
      logger.info('cashfree_mode_stub');
    }
    cached = new StubCashfree();
  }
  return cached;
}

/** Test-only reset. */
export function __resetCashfreeForTesting(): void {
  cached = undefined;
  stubCounter = 0;
  stubCancelledOrders = [];
}

/** Test-only: order ids the stub adapter was asked to cancel. */
export function __getStubCashfreeCancelledOrders(): readonly string[] {
  return stubCancelledOrders;
}
