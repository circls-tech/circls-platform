import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Force the LIVE adapter so we can exercise real signature verification —
// the default test env has no Stripe keys and would yield the stub.
const WEBHOOK_SECRET = 'whsec_test_secret';
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent', // stripe.ts pulls in lib/logger.js, which reads this
    // All three must be set — a partial config falls back to the stub.
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
  },
}));

import { getStripe, __resetStripeForTesting } from './stripe.js';

afterEach(() => __resetStripeForTesting());

function sign(body: string, timestampSec: number, secret = WEBHOOK_SECRET): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${v1}`;
}

describe('LiveStripe.verifyWebhookSignature', () => {
  const body = '{"id":"evt_1","type":"payment_intent.succeeded"}';

  it('accepts a valid, fresh signature', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(getStripe().verifyWebhookSignature(body, sign(body, now))).toBe(true);
  });

  it('accepts when a valid v1 appears alongside other candidates', () => {
    const now = Math.floor(Date.now() / 1000);
    const good = sign(body, now);
    expect(getStripe().verifyWebhookSignature(body, `${good},v1=${'0'.repeat(64)}`)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(getStripe().verifyWebhookSignature(body, sign(body, now, 'whsec_other'))).toBe(false);
  });

  it('rejects a signature over different bytes', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(getStripe().verifyWebhookSignature('{"tampered":true}', sign(body, now))).toBe(false);
  });

  it('rejects a stale timestamp (replay window)', () => {
    const stale = Math.floor(Date.now() / 1000) - 600; // > 300s tolerance
    expect(getStripe().verifyWebhookSignature(body, sign(body, stale))).toBe(false);
  });

  it('rejects malformed headers', () => {
    expect(getStripe().verifyWebhookSignature(body, '')).toBe(false);
    expect(getStripe().verifyWebhookSignature(body, 'v1=deadbeef')).toBe(false);
    expect(getStripe().verifyWebhookSignature(body, 't=notanumber,v1=deadbeef')).toBe(false);
  });

  it('runs in live mode with the mocked keys', () => {
    expect(getStripe().mode).toBe('live');
    expect(getStripe().provider).toBe('stripe');
  });
});
