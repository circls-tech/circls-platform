import { afterEach, describe, expect, it, vi } from 'vitest';

// A PARTIAL Stripe config (secret key present, webhook secret + publishable
// key missing) must fall back to the stub: going live would let customers pay
// for bookings whose capture webhooks can never be verified — charged but
// never confirmed. See getStripe() in stripe.ts.
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent', // stripe.ts pulls in lib/logger.js, which reads this
    STRIPE_SECRET_KEY: 'sk_test_only_this_one',
  },
}));

import { getStripe, __resetStripeForTesting } from './stripe.js';

afterEach(() => __resetStripeForTesting());

describe('getStripe with a partial config', () => {
  it('uses the stub, never the live adapter', async () => {
    const gw = getStripe();
    expect(gw.mode).toBe('stub');
    expect(gw.provider).toBe('stripe');

    // Stub orders keep US bookings on the "reserved" path — deterministic ids,
    // no network, no real PaymentIntent a customer could pay.
    const order = await gw.createOrder({ amountMinor: 1000, currency: 'USD', reference: 'b1' });
    expect(order.id).toMatch(/^stub_pi_/);
  });
});
