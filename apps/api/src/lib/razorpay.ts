/**
 * Razorpay port. Phases 11/12/14 (Track B).
 *
 * Wraps the three calls we make today:
 *   1. `accounts.create()`     — Linked Account for KYC (Phase 11).
 *   2. `orders.create()`       — Route order for online booking (Phase 12).
 *   3. `payments.refund()`     — refunds (Phase 14).
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

export interface KycSubmission {
  /** Legal entity name from the tenant. */
  legalName: string;
  /** Contact email for Razorpay correspondence. */
  email: string;
  phone?: string | undefined;
  pan?: string | undefined;
  gstin?: string | undefined;
  bank?:
    | {
        accountNumber: string;
        ifsc: string;
        holderName: string;
      }
    | undefined;
}

export interface LinkedAccount {
  id: string;
  status: 'created' | 'under_review' | 'activated' | 'rejected';
  raw?: Record<string, unknown> | undefined;
}

export interface RouteOrderInput {
  /** Total to charge the customer, in paise. */
  amountPaise: number;
  currency?: 'INR' | undefined;
  /** Razorpay Linked Account id of the venue's tenant. */
  linkedAccountId: string;
  /** Commission the platform keeps, in paise. */
  platformFeePaise: number;
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
  createLinkedAccount(input: KycSubmission): Promise<LinkedAccount>;
  fetchLinkedAccount(id: string): Promise<LinkedAccount>;
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

  async createLinkedAccount(input: KycSubmission): Promise<LinkedAccount> {
    return {
      id: nextStubId('la'),
      status: 'under_review',
      raw: { stub: true, legalName: input.legalName },
    };
  }

  async fetchLinkedAccount(id: string): Promise<LinkedAccount> {
    // Stub always reports activated after one fetch. Tests that need different
    // paths should mock the adapter directly.
    return { id, status: 'activated' };
  }

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

// ── Live adapter (Phase 11/12 will fill these in) ───────────────────────────
class LiveRazorpay implements RazorpayAdapter {
  readonly mode = 'live' as const;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string | undefined,
  ) {}

  async createLinkedAccount(_input: KycSubmission): Promise<LinkedAccount> {
    throw new Error('LiveRazorpay.createLinkedAccount not implemented — phase 11');
  }

  async fetchLinkedAccount(_id: string): Promise<LinkedAccount> {
    throw new Error('LiveRazorpay.fetchLinkedAccount not implemented — phase 11');
  }

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
