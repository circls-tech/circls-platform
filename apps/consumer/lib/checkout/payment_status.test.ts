import { describe, expect, it, vi } from 'vitest';
import type { CheckoutPaymentStatus } from '../api/types';
import { pollCheckoutPayment } from './payment_status';

const noWait = () => Promise.resolve();

/** A status check answering from a script, one entry per call. */
function scripted(...answers: (CheckoutPaymentStatus | Error)[]) {
  return vi.fn(async () => {
    const next = answers.shift() ?? 'pending';
    if (next instanceof Error) throw next;
    return next;
  });
}

describe('pollCheckoutPayment', () => {
  it('asks until the payment is confirmed', async () => {
    const check = scripted('pending', 'pending', 'paid');
    await expect(pollCheckoutPayment(check, { attempts: 8, intervalMs: 2000, wait: noWait })).resolves.toBe('paid');
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('stops at a declined or expired checkout', async () => {
    await expect(
      pollCheckoutPayment(scripted('pending', 'failed'), { attempts: 8, intervalMs: 0, wait: noWait }),
    ).resolves.toBe('failed');
    await expect(
      pollCheckoutPayment(scripted('expired'), { attempts: 8, intervalMs: 0, wait: noWait }),
    ).resolves.toBe('expired');
  });

  it('a failed request is not a failed payment', async () => {
    const check = scripted(new Error('offline'), 'paid');
    await expect(pollCheckoutPayment(check, { attempts: 3, intervalMs: 0, wait: noWait })).resolves.toBe('paid');
  });

  it('keeps waiting while a payment is processing, and says so if it still is', async () => {
    const check = scripted('processing', 'processing', 'paid');
    await expect(pollCheckoutPayment(check, { attempts: 8, intervalMs: 0, wait: noWait })).resolves.toBe('paid');
    // Still in flight at the end — and a later failed request doesn't erase it.
    await expect(
      pollCheckoutPayment(scripted('processing', new Error('offline')), { attempts: 2, intervalMs: 0, wait: noWait }),
    ).resolves.toBe('processing');
  });

  it('gives up as pending, waiting between asks', async () => {
    const wait = vi.fn(noWait);
    const check = scripted();
    await expect(pollCheckoutPayment(check, { attempts: 3, intervalMs: 2000, wait })).resolves.toBe('pending');
    expect(check).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(2000);
  });
});
