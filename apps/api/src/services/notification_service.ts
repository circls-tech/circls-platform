/**
 * Notification service — wraps the lib/notifications dispatcher with the
 * application-level helpers (booking confirmation, KYC update, reminder
 * scheduling, OTP). Phase 13 owner fills in template rendering + the
 * scheduled-reminder cron logic.
 */
import { logger } from '../lib/logger.js';
import { getNotifications, type DispatchInput } from '../lib/notifications/index.js';

/** Generic passthrough — kept thin so route handlers can call it. */
export async function dispatch(input: DispatchInput) {
  return getNotifications().dispatch(input);
}

/** Worker handler — runs every minute. Returns count of attempted sends. */
export async function processPendingNotifications(): Promise<number> {
  try {
    return await getNotifications().processPending();
  } catch (err) {
    logger.error({ err }, 'notifications_worker_failed');
    return 0;
  }
}

/** Called from booking confirmation flow (Phase 13 wires this up). */
export async function notifyBookingConfirmed(_bookingId: string): Promise<void> {
  // TODO(phase-13): render template, schedule T-24h + T-1h reminders.
}

/** Called from cancellation/refund flow. */
export async function notifyBookingCancelled(_bookingId: string): Promise<void> {
  // TODO(phase-13).
}

/** Called from kyc_service state transitions. */
export async function notifyKycStateChange(
  _tenantId: string,
  _newStatus: string,
): Promise<void> {
  // TODO(phase-13).
}
