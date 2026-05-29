/**
 * Razorpay port. Phases 12/14 (Track B).
 *
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

// ── Common types ────────────────────────────────────────────────────────────
export type RazorpayMode = 'stub' | 'live';

export interface RouteOrderInput {
  /** Total to charge the customer, in paise. */
  amountPaise: number;
  currency?: 'INR' | undefined;
  /** Our booking id — surfaces in Razorpay dashboard for reconciliation. */
  reference: string;
  notes?: Record<string, string> | undefined;
}

export interface RouteOrder {
  id: string;
  status: 'created' | 'attempted' | 'paid';
  amountPaise: number;
}

export interface RefundInput {
  paymentId: string;
  amountPaise: number;
  reason?: string | undefined;
  reference: string;
}

export interface RefundResult {
  id: string;
  status: 'pending' | 'processed' | 'failed';
  amountPaise: number;
}

export interface RazorpayAdapter {
  readonly mode: RazorpayMode;
  createRouteOrder(input: RouteOrderInput): Promise<RouteOrder>;
  refundPayment(input: RefundInput): Promise<RefundResult>;
  /** HMAC-SHA256 verify of a Razorpay webhook body. */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
}

// ── Stub adapter ────────────────────────────────────────────────────────────
let stubCounter = 0;
const nextStubId = (prefix: string): string => `stub_${prefix}_${++stubCounter}`;

class StubRazorpay implements RazorpayAdapter {
  readonly mode = 'stub' as const;

  async createRouteOrder(input: RouteOrderInput): Promise<RouteOrder> {
    return { id: nextStubId('order'), status: 'created', amountPaise: input.amountPaise };
  }

  async refundPayment(input: RefundInput): Promise<RefundResult> {
    return { id: nextStubId('rfnd'), status: 'processed', amountPaise: input.amountPaise };
  }

  verifyWebhookSignature(_rawBody: string, _signature: string): boolean {
    // In stub mode we accept anything — tests should override if they care.
    return true;
  }
}

// ── Live adapter ────────────────────────────────────────────────────────────
const RAZORPAY_API = 'https://api.razorpay.com/v1';

class LiveRazorpay implements RazorpayAdapter {
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
  async createRouteOrder(input: RouteOrderInput): Promise<RouteOrder> {
    const order = await this.call<{ id: string; status: string; amount: number }>(
      'POST',
      '/orders',
      {
        amount: input.amountPaise,
        currency: input.currency ?? 'INR',
        receipt: input.reference,
        ...(input.notes ? { notes: input.notes } : {}),
      },
    );
    const status: RouteOrder['status'] =
      order.status === 'paid' ? 'paid' : order.status === 'attempted' ? 'attempted' : 'created';
    return { id: order.id, status, amountPaise: Number(order.amount) };
  }

  // https://razorpay.com/docs/api/refunds/create-normal/
  async refundPayment(input: RefundInput): Promise<RefundResult> {
    const refund = await this.call<{ id: string; status: string; amount: number }>(
      'POST',
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      {
        amount: input.amountPaise,
        ...(input.reason ? { notes: { reason: input.reason } } : {}),
        ...(input.reference ? { receipt: input.reference } : {}),
      },
    );
    const status: RefundResult['status'] =
      refund.status === 'processed' ? 'processed' : refund.status === 'failed' ? 'failed' : 'pending';
    return { id: refund.id, status, amountPaise: Number(refund.amount) };
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

let cached: RazorpayAdapter | undefined;

export function getRazorpay(): RazorpayAdapter {
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
