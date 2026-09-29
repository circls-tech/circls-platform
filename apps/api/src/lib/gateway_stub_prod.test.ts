import { describe, expect, it, vi } from 'vitest';

// Production with no gateway keys wired (and a half-configured Stripe):
// every adapter is a stub. Stubs may still mint "reserved" orders, but must
// never pretend to refund or cancel — in production a stub adapter means the
// keys were removed while real charges still point at that gateway.
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'production',
    LOG_LEVEL: 'silent',
    CASHFREE_ENV: 'production',
    INR_PAYMENT_GATEWAY: 'razorpay',
    // Publishable key without the secret + webhook secret → StubStripe.
    STRIPE_PUBLISHABLE_KEY: 'pk_live_orphan',
    GATEWAY_HTTP_TIMEOUT_MS: 10_000,
  },
}));

import { getGateway, publicKeyIdFor, type PaymentProviderId } from './gateway.js';

const refundInput = {
  paymentId: 'pay_1',
  orderId: 'order_1',
  refundId: 'rkey1',
  amountMinor: 100,
  reference: 'booking-1',
};

describe.each<PaymentProviderId>(['razorpay', 'stripe', 'cashfree'])('%s stub in production', (provider) => {
  const gateway = getGateway(provider);

  it('is a stub', () => {
    expect(gateway.mode).toBe('stub');
  });

  it('refuses to fake a refund', async () => {
    await expect(gateway.refundPayment(refundInput)).rejects.toThrow(/not configured/);
  });

  it('refuses to fake an order cancel', async () => {
    await expect(gateway.cancelOrder('order_1')).rejects.toThrow(/not configured/);
  });

  it('still mints a reserved (never-charged) order', async () => {
    const order = await gateway.createOrder({
      amountMinor: 100,
      currency: provider === 'stripe' ? 'USD' : 'INR',
      reference: 'booking-1',
      chargeId: 'charge-1',
    });
    expect(order.id).toMatch(/^stub_/);
  });

  it('hands the browser no key, even when a key env var is set', () => {
    expect(publicKeyIdFor(provider)).toBe('');
  });
});
