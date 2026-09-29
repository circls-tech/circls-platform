/**
 * Automatic INR failover — a circuit breaker on Cashfree order creation.
 *
 * Every Cashfree outage (timeout, network error, 5xx, 429 — see
 * GatewayHttpError.outage) is recorded. Once `INR_FAILOVER_THRESHOLD` land
 * within `INR_FAILOVER_WINDOW_SEC`, failover is active for
 * `INR_FAILOVER_COOLDOWN_SEC`: new INR orders skip Cashfree and go straight to
 * Razorpay, so customers stop paying a timeout each while Cashfree is down.
 * After the cooldown the next order tries Cashfree again.
 *
 * In-process state: production runs one API instance (Coolify), and a restart
 * simply retries Cashfree. A single failed order falls back to Razorpay
 * whether or not failover is active (payments_service.createPaymentOrder).
 */
import { env } from '../config/env.js';
import { logger } from './logger.js';

let outages: number[] = [];
let activeUntil = 0;

export function isCashfreeFailoverActive(now: number = Date.now()): boolean {
  return now < activeUntil;
}

export function recordCashfreeOutage(now: number = Date.now()): void {
  const windowMs = env.INR_FAILOVER_WINDOW_SEC * 1000;
  outages = outages.filter((t) => now - t < windowMs);
  outages.push(now);
  if (outages.length >= env.INR_FAILOVER_THRESHOLD && !isCashfreeFailoverActive(now)) {
    activeUntil = now + env.INR_FAILOVER_COOLDOWN_SEC * 1000;
    outages = [];
    logger.error(
      { until: new Date(activeUntil).toISOString(), threshold: env.INR_FAILOVER_THRESHOLD },
      'inr_failover_activated',
    );
  }
}

/** An admin retries Cashfree now instead of waiting out the cooldown. */
export function clearCashfreeFailover(): void {
  outages = [];
  activeUntil = 0;
  logger.info('inr_failover_cleared');
}

export interface CashfreeFailoverState {
  active: boolean;
  /** When new INR orders go back to Cashfree, while active. */
  until: string | null;
  /** Outages inside the current window, while not active. */
  recentOutages: number;
}

export function cashfreeFailoverState(now: number = Date.now()): CashfreeFailoverState {
  const windowMs = env.INR_FAILOVER_WINDOW_SEC * 1000;
  const active = isCashfreeFailoverActive(now);
  return {
    active,
    until: active ? new Date(activeUntil).toISOString() : null,
    recentOutages: outages.filter((t) => now - t < windowMs).length,
  };
}

/** Test-only reset. */
export function __resetInrFailoverForTesting(): void {
  outages = [];
  activeUntil = 0;
}
