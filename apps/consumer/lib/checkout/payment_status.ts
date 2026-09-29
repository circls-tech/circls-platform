import type { CheckoutPaymentStatus } from '../api/types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ask where a checkout's payment stands until there's an answer: 'paid',
 * 'failed' or 'expired' end the wait; 'pending' is asked again every
 * `intervalMs`, `attempts` times in all, then returned. A request that errors
 * counts as pending — a network blip must never read as a declined payment.
 */
export async function pollCheckoutPayment(
  check: () => Promise<CheckoutPaymentStatus>,
  { attempts, intervalMs, wait = sleep }: {
    attempts: number;
    intervalMs: number;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<CheckoutPaymentStatus> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await wait(intervalMs);
    const status = await check().catch((): CheckoutPaymentStatus => 'pending');
    if (status !== 'pending') return status;
  }
  return 'pending';
}
