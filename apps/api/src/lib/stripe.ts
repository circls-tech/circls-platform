/**
 * Stripe gateway adapter (US venues).
 *
 * Implements the provider-agnostic `PaymentGateway` port (see gateway.ts).
 * Circls is the merchant — a plain PaymentIntent per booking, no Connect:
 *   1. `POST /v1/payment_intents` — order for online booking. The returned
 *      `client_secret` is handed to the browser, which confirms the payment
 *      with Stripe.js; capture is then reported via webhook.
 *   2. `POST /v1/refunds`        — refunds against the captured charge.
 *
 * Webhook signature: Stripe signs `${t}.${rawBody}` with the endpoint secret
 * and sends `t=<ts>,v1=<hmac>[,v1=…]` in the `Stripe-Signature` header.
 *
 * When `STRIPE_SECRET_KEY` env is absent the stub adapter returns
 * deterministic ids prefixed `stub_` so tests can assert on shape without
 * network — mirrors the Razorpay stub.
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

class StubStripe implements PaymentGateway {
  readonly provider = 'stripe' as const;
  readonly mode = 'stub' as const;

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const id = nextStubId('pi');
    return {
      id,
      status: 'created',
      amountMinor: input.amountMinor,
      clientSecret: `${id}_secret`,
    };
  }

  async refundPayment(input: GatewayRefundInput): Promise<GatewayRefundResult> {
    return { id: nextStubId('re'), status: 'processed', amountMinor: input.amountMinor };
  }

  verifyWebhookSignature(_rawBody: string, _signature: string): boolean {
    // In stub mode we accept anything — tests should override if they care.
    return true;
  }
}

// ── Live adapter ────────────────────────────────────────────────────────────
const STRIPE_API = 'https://api.stripe.com/v1';

/** Replay window for webhook signatures, matching stripe-node's default. */
const SIGNATURE_TOLERANCE_SEC = 300;

class LiveStripe implements PaymentGateway {
  readonly provider = 'stripe' as const;
  readonly mode = 'live' as const;
  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string | undefined,
  ) {}

  private async call<T>(path: string, body: Record<string, string>): Promise<T> {
    const res = await fetch(`${STRIPE_API}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body).toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        /* keep raw text */
      }
      logger.error({ status: res.status, path, message }, 'stripe_api_error');
      throw new Error(`Stripe ${path} failed (${res.status}): ${message}`);
    }
    return JSON.parse(text) as T;
  }

  // https://docs.stripe.com/api/payment_intents/create
  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    const pi = await this.call<{
      id: string;
      status: string;
      amount: number;
      client_secret: string;
    }>('/payment_intents', {
      amount: String(input.amountMinor),
      currency: input.currency.toLowerCase(),
      'metadata[reference]': input.reference,
      // Card only, deliberately: the consumer overlay confirms with
      // `redirect: 'if_required'` and no return_url, which Stripe rejects for
      // redirect-based methods (wallets, bank redirects). Enabling those needs
      // a return_url + a checkout return page first.
      'payment_method_types[0]': 'card',
      ...(input.notes
        ? Object.fromEntries(
            Object.entries(input.notes).map(([k, v]) => [`metadata[${k}]`, v]),
          )
        : {}),
    });
    const status: GatewayOrder['status'] =
      pi.status === 'succeeded' ? 'paid' : pi.status === 'processing' ? 'attempted' : 'created';
    return {
      id: pi.id,
      status,
      amountMinor: Number(pi.amount),
      clientSecret: pi.client_secret,
    };
  }

  // https://docs.stripe.com/api/refunds/create
  // `paymentId` is whatever we persisted on the charge row: the charge id
  // (ch_…) captured from the webhook, or the PaymentIntent id (pi_…) as a
  // fallback — Stripe accepts either, via different params.
  async refundPayment(input: GatewayRefundInput): Promise<GatewayRefundResult> {
    const target = input.paymentId.startsWith('pi_')
      ? { payment_intent: input.paymentId }
      : { charge: input.paymentId };
    const refund = await this.call<{ id: string; status: string; amount: number }>('/refunds', {
      ...target,
      amount: String(input.amountMinor),
      'metadata[reference]': input.reference,
      ...(input.reason ? { 'metadata[reason]': input.reason } : {}),
    });
    const status: GatewayRefundResult['status'] =
      refund.status === 'succeeded'
        ? 'processed'
        : refund.status === 'failed' || refund.status === 'canceled'
          ? 'failed'
          : 'pending';
    return { id: refund.id, status, amountMinor: Number(refund.amount) };
  }

  // https://docs.stripe.com/webhooks#verify-manually
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (!this.webhookSecret) return false;
    let timestamp: string | undefined;
    const candidates: string[] = [];
    for (const part of signature.split(',')) {
      const [key, value] = part.split('=', 2);
      if (key === 't' && value) timestamp = value;
      if (key === 'v1' && value) candidates.push(value);
    }
    if (!timestamp || candidates.length === 0) return false;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(Date.now() / 1000 - ts) > SIGNATURE_TOLERANCE_SEC) return false;

    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    const a = Buffer.from(expected, 'hex');
    return candidates.some((candidate) => {
      const b = Buffer.from(candidate, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
  }
}

let cached: PaymentGateway | undefined;

export function getStripe(): PaymentGateway {
  if (cached) return cached;
  if (env.STRIPE_SECRET_KEY) {
    cached = new LiveStripe(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET);
    logger.info('stripe_mode_live');
  } else {
    cached = new StubStripe();
    logger.info('stripe_mode_stub');
  }
  return cached;
}

/** Test-only reset. */
export function __resetStripeForTesting(): void {
  cached = undefined;
  stubCounter = 0;
}
