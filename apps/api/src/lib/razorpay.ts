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

// ── Live adapter (Phase 12 will fill these in) ──────────────────────────────
class LiveRazorpay implements RazorpayAdapter {
  readonly mode = 'live' as const;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string | undefined,
  ) {}

  async createRouteOrder(_input: RouteOrderInput): Promise<RouteOrder> {
    throw new Error('LiveRazorpay.createRouteOrder not implemented — phase 12');
  }

  async refundPayment(_input: RefundInput): Promise<RefundResult> {
    throw new Error('LiveRazorpay.refundPayment not implemented — phase 14');
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
