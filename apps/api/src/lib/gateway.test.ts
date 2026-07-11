import { describe, expect, it } from 'vitest';
import {
  currencyForCountry,
  getGateway,
  providerForCountry,
  publicKeyIdFor,
} from './gateway.js';

describe('providerForCountry / currencyForCountry', () => {
  it('routes US venues to stripe/USD across the spellings the app stores', () => {
    // The venue dropdown stores 'USA'; the tenant profile is free text.
    for (const c of ['USA', 'US', 'usa', ' United States ', 'united states of america']) {
      expect(providerForCountry(c)).toBe('stripe');
      expect(currencyForCountry(c)).toBe('USD');
    }
  });

  it('routes everything else (incl. missing country) to razorpay/INR', () => {
    for (const c of ['India', 'IN', 'india', '', null, undefined, 'Uganda']) {
      expect(providerForCountry(c)).toBe('razorpay');
      expect(currencyForCountry(c)).toBe('INR');
    }
  });
});

describe('getGateway (stub mode — no keys in test env)', () => {
  it('returns a razorpay-stub and a stripe-stub adapter', () => {
    expect(getGateway('razorpay').provider).toBe('razorpay');
    expect(getGateway('razorpay').mode).toBe('stub');
    expect(getGateway('stripe').provider).toBe('stripe');
    expect(getGateway('stripe').mode).toBe('stub');
  });

  it('stripe stub mints deterministic ids with a client secret', async () => {
    const order = await getGateway('stripe').createOrder({
      amountMinor: 1299,
      currency: 'USD',
      reference: 'booking-1',
    });
    expect(order.id).toMatch(/^stub_pi_\d+$/);
    expect(order.clientSecret).toBe(`${order.id}_secret`);
    expect(order.status).toBe('created');
    expect(order.amountMinor).toBe(1299);
  });

  it('razorpay orders carry no client secret', async () => {
    const order = await getGateway('razorpay').createOrder({
      amountMinor: 50000,
      currency: 'INR',
      reference: 'booking-2',
    });
    expect(order.clientSecret).toBeUndefined();
  });
});

describe('publicKeyIdFor', () => {
  it('is empty in stub mode so the client shows "reserved"', () => {
    expect(publicKeyIdFor('razorpay')).toBe('');
    expect(publicKeyIdFor('stripe')).toBe('');
  });
});
