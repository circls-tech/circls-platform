/**
 * Razorpay gateway adapter. Phases 12/14 (Track B).
 *
 * Implements the provider-agnostic `PaymentGateway` port (see gateway.ts).
 * Circls is the merchant — there are no per-tenant Linked Accounts or KYC.
 * Wraps the two calls we make today:
 *   1. `orders.create()`       — plain order for online booking (Phase 12).
 *   2. `payments.refund()`     — refunds (Phase 14).
 *
 * Plus webhook signature verification (HMAC-SHA256 over the raw body).
 *
 * When `RAZORPAY_KEY_*` env is absent the stub adapter returns deterministic
 * ids prefixed `stub_` so tests can assert on shape without network.
 */
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import type {
  CreateOrderInput,
  GatewayOrder,
  GatewayRefundInput,
  GatewayRefundResult,
  PaymentGateway,
} from './gateway.js';

// ── Stub adapter ────────────────────────────────────────────────────────────
let stubCounter = 0;
const nextStubId = (prefix: string): string => `stub_${prefix}_${++stubCounter}`;

class StubRazorpay implements PaymentGateway {
  readonly provider = 'razorpay' as const;
  readonly mode = 'stub' as const;

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    return { id: nextStubId('order'), status: 'created', amountMinor: input.amountMinor };
  }

  async refundPayment(input: GatewayRefundInput): Promise<GatewayRefundResult> {
    return { id: nextStubId('rfnd'), status: 'processed', amountMinor: input.amountMinor };
  }

  verifyWebhookSignature(_rawBody: string, _signature: string): boolean {
    // In stub mode we accept anything — tests should override if they care.
    return true;
  }
}

// ── Live adapter ────────────────────────────────────────────────────────────
const RAZORPAY_API = 'https://api.razorpay.com/v1';

class LiveRazorpay implements PaymentGateway {
  readonly provider = 'razorpay' as const;
  readonly mode = 'live' as const;
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string | undefined,
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
  }

  private async call<T>(method: 'POST', path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${RAZORPAY_API}${path}`, {
      method,
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { description?: string } }).error?.description ?? text;
      } catch {
        /* keep raw text */
      }
      logger.error({ status: res.status, path, message }, 'razorpay_api_error');
      throw new Error(`Razorpay ${path} failed (${res.status}): ${message}`);
    }
    return JSON.parse(text) as T;
  }

  // Circls is the merchant — a plain Orders API order (no Route/transfers).
  // https://razorpay.com/docs/api/orders/create/
  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const order = await this.call<{ id: string; status: string; amount: number }>(
      'POST',
      '/orders',
      {
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.reference,
        ...(input.notes ? { notes: input.notes } : {}),
      },
    );
    const status: GatewayOrder['status'] =
      order.status === 'paid' ? 'paid' : order.status === 'attempted' ? 'attempted' : 'created';
    return { id: order.id, status, amountMinor: Number(order.amount) };
  }

  // https://razorpay.com/docs/api/refunds/create-normal/
  async refundPayment(input: GatewayRefundInput): Promise<GatewayRefundResult> {
    const refund = await this.call<{ id: string; status: string; amount: number }>(
      'POST',
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      {
        amount: input.amountMinor,
        ...(input.reason ? { notes: { reason: input.reason } } : {}),
        ...(input.reference ? { receipt: input.reference } : {}),
      },
    );
    const status: GatewayRefundResult['status'] =
      refund.status === 'processed' ? 'processed' : refund.status === 'failed' ? 'failed' : 'pending';
    return { id: refund.id, status, amountMinor: Number(refund.amount) };
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!this.webhookSecret) return false;
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
    // Timing-safe compare on equal-length buffers.
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}

let cached: PaymentGateway | undefined;

export function getRazorpay(): PaymentGateway {
  if (cached) return cached;
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    cached = new LiveRazorpay(
      env.RAZORPAY_KEY_ID,
      env.RAZORPAY_KEY_SECRET,
      env.RAZORPAY_WEBHOOK_SECRET,
    );
    logger.info('razorpay_mode_live');
  } else {
    cached = new StubRazorpay();
    logger.info('razorpay_mode_stub');
  }
  return cached;
}

/** Test-only reset. */
export function __resetRazorpayForTesting(): void {
  cached = undefined;
  stubCounter = 0;
}
