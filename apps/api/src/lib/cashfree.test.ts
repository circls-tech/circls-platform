import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Force the LIVE adapter (and route INR to Cashfree) so we can exercise the
// real request shapes + signature verification — the default test env has no
// Cashfree keys and would yield the stub. fetch is stubbed per test.
const CLIENT_SECRET = 'cfsk_test_secret';
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent', // cashfree.ts pulls in lib/logger.js, which reads this
    CASHFREE_CLIENT_ID: 'cf_app_id',
    CASHFREE_CLIENT_SECRET: 'cfsk_test_secret',
    CASHFREE_ENV: 'sandbox',
    INR_PAYMENT_GATEWAY: 'cashfree',
    CONSUMER_BASE_URL: 'https://circls.app',
    GATEWAY_HTTP_TIMEOUT_MS: 10_000,
  },
}));

import {
  CASHFREE_API_VERSION,
  cashfreeAmountToMinor,
  cashfreeRefundId,
  getCashfree,
  mapCashfreeRefundStatus,
  minorToCashfreeAmount,
  __resetCashfreeForTesting,
} from './cashfree.js';
import { providerForCountry, publicKeyIdFor } from './gateway.js';

afterEach(() => {
  __resetCashfreeForTesting();
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof stubFetch>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string) as Record<string, unknown>,
  };
}

describe('INR routing with INR_PAYMENT_GATEWAY=cashfree', () => {
  it('sends non-US venues to cashfree and keeps US on stripe', () => {
    expect(providerForCountry('India')).toBe('cashfree');
    expect(providerForCountry(null)).toBe('cashfree');
    expect(providerForCountry('USA')).toBe('stripe');
  });

  it('exposes the SDK mode as the browser "key" in live mode', () => {
    expect(publicKeyIdFor('cashfree')).toBe('sandbox');
  });
});

describe('amount conversion', () => {
  it('round-trips paise through rupee decimals', () => {
    expect(minorToCashfreeAmount(123456)).toBe(1234.56);
    expect(minorToCashfreeAmount(100)).toBe(1);
    expect(cashfreeAmountToMinor(1234.56)).toBe(123456);
    // Float noise from the wire must not cost a paisa (0.29 * 100 = 28.999…).
    expect(cashfreeAmountToMinor(0.29)).toBe(29);
  });
});

describe('LiveCashfree.createOrder', () => {
  it('posts our charge id, rupee amount and customer details', async () => {
    const fetchMock = stubFetch(200, {
      order_id: 'charge-uuid-1',
      order_status: 'ACTIVE',
      order_amount: 1234.56,
      payment_session_id: 'session_abc',
    });
    const order = await getCashfree().createOrder({
      amountMinor: 123456,
      currency: 'INR',
      reference: 'booking-uuid-1',
      chargeId: 'charge-uuid-1',
      customer: {
        id: '0b1c2d3e-aaaa-bbbb-cccc-111122223333',
        phoneE164: '+919876543210',
        email: 'a@example.com',
        name: 'Asha',
      },
    });

    const call = lastCall(fetchMock);
    expect(call.url).toBe('https://sandbox.cashfree.com/pg/orders');
    expect(call.method).toBe('POST');
    expect(call.headers['x-client-id']).toBe('cf_app_id');
    expect(call.headers['x-client-secret']).toBe(CLIENT_SECRET);
    expect(call.headers['x-api-version']).toBe(CASHFREE_API_VERSION);
    expect(call.body).toMatchObject({
      order_id: 'charge-uuid-1',
      order_amount: 1234.56,
      order_currency: 'INR',
      customer_details: {
        // Cashfree customer ids are alphanumeric-only.
        customer_id: '0b1c2d3eaaaabbbbcccc111122223333',
        customer_phone: '9876543210',
        customer_email: 'a@example.com',
        customer_name: 'Asha',
      },
      order_meta: { return_url: 'https://circls.app/me/bookings' },
      order_tags: { booking_id: 'booking-uuid-1' },
    });

    expect(order).toEqual({
      id: 'charge-uuid-1',
      status: 'created',
      amountMinor: 123456,
      clientSecret: 'session_abc',
    });
  });

  it('falls back to a placeholder phone and the booking id when the customer is unknown', async () => {
    const fetchMock = stubFetch(200, {
      order_id: 'c2',
      order_status: 'ACTIVE',
      order_amount: 10,
      payment_session_id: 's2',
    });
    await getCashfree().createOrder({
      amountMinor: 1000,
      currency: 'INR',
      reference: 'bkg-2-abc',
      chargeId: 'c2',
    });
    expect(lastCall(fetchMock).body['customer_details']).toEqual({
      customer_id: 'bkg2abc',
      customer_phone: '9999999999',
    });
  });

  it('keeps international numbers +-prefixed', async () => {
    const fetchMock = stubFetch(200, {
      order_id: 'c3',
      order_status: 'ACTIVE',
      order_amount: 10,
      payment_session_id: 's3',
    });
    await getCashfree().createOrder({
      amountMinor: 1000,
      currency: 'INR',
      reference: 'b3',
      chargeId: 'c3',
      customer: { id: 'user3', phoneE164: '+14155550123' },
    });
    const details = lastCall(fetchMock).body['customer_details'] as Record<string, unknown>;
    expect(details['customer_phone']).toBe('+14155550123');
  });

  it('throws on an API error so the charge row stays pending', async () => {
    stubFetch(400, { message: 'order_amount : invalid value', code: 'order_amount_invalid' });
    await expect(
      getCashfree().createOrder({ amountMinor: 1, currency: 'INR', reference: 'b', chargeId: 'c' }),
    ).rejects.toThrow(/order_amount : invalid value/);
  });
});

describe('LiveCashfree.cancelOrder', () => {
  it('terminates the order', async () => {
    const fetchMock = stubFetch(200, { order_id: 'c1', order_status: 'TERMINATION_REQUESTED', order_amount: 10 });
    await getCashfree().cancelOrder('c1');
    const call = lastCall(fetchMock);
    expect(call.url).toBe('https://sandbox.cashfree.com/pg/orders/c1');
    expect(call.method).toBe('PATCH');
    expect(call.body).toEqual({ order_status: 'TERMINATED' });
  });

  it('throws when the order was paid first (lost the race to a capture)', async () => {
    stubFetch(200, { order_id: 'c1', order_status: 'PAID', order_amount: 10 });
    await expect(getCashfree().cancelOrder('c1')).rejects.toThrow(/not terminated/);
  });
});

describe('LiveCashfree.refundPayment', () => {
  it('refunds by order id, keyed for idempotency by our refund key', async () => {
    const fetchMock = stubFetch(200, {
      cf_refund_id: 11325632,
      refund_status: 'PENDING',
      refund_amount: 250.5,
    });
    const res = await getCashfree().refundPayment({
      paymentId: '789727431',
      orderId: 'charge-uuid-1',
      refundId: 'aaaa-bbbb-cccc',
      amountMinor: 25050,
      reason: 'customer cancelled',
      reference: 'booking-uuid-1',
    });
    const call = lastCall(fetchMock);
    expect(call.url).toBe('https://sandbox.cashfree.com/pg/orders/charge-uuid-1/refunds');
    // No refund_note: a retry with another reason would change the body under
    // the same idempotency key, which Cashfree rejects.
    expect(call.body).toEqual({
      refund_amount: 250.5,
      refund_id: 'aaaabbbbcccc',
    });
    // The same key on every retry of this refund: Cashfree returns the
    // original refund instead of creating a second one.
    expect(call.headers['x-idempotency-key']).toBe('aaaa-bbbb-cccc');
    expect(res).toEqual({ id: '11325632', status: 'pending', amountMinor: 25050 });
  });

  it('refuses to refund without an order id', async () => {
    await expect(
      getCashfree().refundPayment({
        paymentId: 'p1',
        refundId: 'r1',
        amountMinor: 100,
        reference: 'b1',
      }),
    ).rejects.toThrow(/needs the order id/);
  });

  it('maps refund statuses', () => {
    expect(mapCashfreeRefundStatus('SUCCESS')).toBe('processed');
    expect(mapCashfreeRefundStatus('CANCELLED')).toBe('failed');
    expect(mapCashfreeRefundStatus('REJECTED')).toBe('failed');
    expect(mapCashfreeRefundStatus('ONHOLD')).toBe('pending');
    expect(mapCashfreeRefundStatus('PENDING_APPROVAL')).toBe('pending');
  });
});

/** A fetch stub answering by URL, recording every request. */
function routeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const fetchMock = vi.fn(async (url: string) => {
    const hit = routes[url];
    if (!hit) return new Response('{"message":"not found"}', { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('LiveCashfree.fetchOrderStatus', () => {
  const base = 'https://sandbox.cashfree.com/pg/orders/charge-1';

  it('an ACTIVE order is still open', async () => {
    const fetchMock = routeFetch({
      [base]: { body: { order_id: 'charge-1', order_status: 'ACTIVE', order_amount: 154.83 } },
    });
    await expect(getCashfree().fetchOrderStatus!('charge-1')).resolves.toEqual({ state: 'open' });
    // Attempts are only looked up when asked for.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports how an open order's latest attempt went, when asked", async () => {
    const active = { body: { order_id: 'charge-1', order_status: 'ACTIVE', order_amount: 154.83 } };
    routeFetch({
      [base]: active,
      [`${base}/payments`]: {
        body: [
          { cf_payment_id: 2, payment_status: 'USER_DROPPED', payment_time: '2026-09-28T10:05:00+05:30' },
          { cf_payment_id: 1, payment_status: 'PENDING', payment_time: '2026-09-28T10:01:00+05:30' },
        ],
      },
    });
    await expect(
      getCashfree().fetchOrderStatus!('charge-1', { lastAttempt: true }),
    ).resolves.toEqual({ state: 'open', lastAttempt: 'failed' });

    routeFetch({
      [base]: active,
      [`${base}/payments`]: {
        body: [
          { cf_payment_id: 1, payment_status: 'FAILED', payment_time: '2026-09-28T10:01:00+05:30' },
          { cf_payment_id: 2, payment_status: 'PENDING', payment_time: '2026-09-28T10:05:00+05:30' },
        ],
      },
    });
    await expect(
      getCashfree().fetchOrderStatus!('charge-1', { lastAttempt: true }),
    ).resolves.toEqual({ state: 'open', lastAttempt: 'pending' });

    routeFetch({ [base]: active, [`${base}/payments`]: { body: [] } });
    await expect(
      getCashfree().fetchOrderStatus!('charge-1', { lastAttempt: true }),
    ).resolves.toEqual({ state: 'open' });
  });

  it('a PAID order reports its successful payment at the ORDER amount', async () => {
    const fetchMock = routeFetch({
      [base]: {
        body: { order_id: 'charge-1', order_status: 'PAID', order_amount: 154.83, order_currency: 'INR' },
      },
      [`${base}/payments`]: {
        body: [
          { cf_payment_id: 111, payment_status: 'FAILED', payment_amount: 154.83 },
          // A Cashfree offer: the payer paid less than the order amount.
          { cf_payment_id: '1457455569833708544', payment_status: 'SUCCESS', payment_amount: 139.35 },
        ],
      },
    });
    await expect(getCashfree().fetchOrderStatus!('charge-1')).resolves.toEqual({
      state: 'paid',
      payment: { id: '1457455569833708544', amountMinor: 15483, currency: 'INR' },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('an expired or terminated order is closed', async () => {
    routeFetch({ [base]: { body: { order_id: 'charge-1', order_status: 'TERMINATED', order_amount: 10 } } });
    await expect(getCashfree().fetchOrderStatus!('charge-1')).resolves.toEqual({ state: 'closed' });
  });
});

describe('LiveCashfree.fetchRefundStatus', () => {
  it('looks the refund up by order and refund key', async () => {
    const key = 'r0b1c2d3eaaaabbbbcccc111122223333n1';
    const fetchMock = routeFetch({
      [`https://sandbox.cashfree.com/pg/orders/charge-1/refunds/${cashfreeRefundId(key)}`]: {
        body: { cf_refund_id: 1319890210, refund_status: 'SUCCESS', refund_amount: 464.49 },
      },
    });
    await expect(
      getCashfree().fetchRefundStatus!({ orderId: 'charge-1', refundId: key }),
    ).resolves.toEqual({ id: '1319890210', status: 'processed', amountMinor: 46449 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a refund on hold pending', async () => {
    routeFetch({
      'https://sandbox.cashfree.com/pg/orders/charge-1/refunds/rabcn1': {
        body: { cf_refund_id: '9', refund_status: 'ONHOLD', refund_amount: 1 },
      },
    });
    const r = await getCashfree().fetchRefundStatus!({ orderId: 'charge-1', refundId: 'rabcn1' });
    expect(r.status).toBe('pending');
  });
});

describe('LiveCashfree.verifyWebhookSignature', () => {
  const body = '{"data":{},"type":"PAYMENT_SUCCESS_WEBHOOK"}';
  const ts = '1785401067911';
  const sign = (b: string, t: string, secret = CLIENT_SECRET) =>
    crypto.createHmac('sha256', secret).update(t + b).digest('base64');

  it('accepts a valid signature', () => {
    expect(getCashfree().verifyWebhookSignature(body, sign(body, ts), ts)).toBe(true);
  });

  it('rejects the wrong secret, tampered bytes, or a different timestamp', () => {
    expect(getCashfree().verifyWebhookSignature(body, sign(body, ts, 'other'), ts)).toBe(false);
    expect(getCashfree().verifyWebhookSignature('{"x":1}', sign(body, ts), ts)).toBe(false);
    expect(getCashfree().verifyWebhookSignature(body, sign(body, ts), '1785401067912')).toBe(false);
  });

  it('rejects a missing timestamp or garbage signature', () => {
    expect(getCashfree().verifyWebhookSignature(body, sign(body, ts))).toBe(false);
    expect(getCashfree().verifyWebhookSignature(body, 'not-base64!!', ts)).toBe(false);
    expect(getCashfree().verifyWebhookSignature(body, '', ts)).toBe(false);
  });
});
