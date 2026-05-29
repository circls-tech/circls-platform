/**
 * Thin shim other phases call after they confirm/cancel a booking. We can't
 * touch `booking_service.ts` directly (Phase 12 + 14 are racing in their own
 * worktrees), so we expose a tiny module instead — Phase 12/14 import it after
 * their state transitions land.
 *
 * Why not an event-emitter: the platform doesn't otherwise have one, and
 * introducing a global emitter is a bigger architectural commitment than this
 * task needs. A direct function call is fine for now; if a third caller shows
 * up we can promote to an emitter or a domain-events bus.
 */
import { logger } from '../lib/logger.js';
import {
  notifyBookingCancelled,
  notifyBookingConfirmed,
} from './notification_service.js';

/**
 * Call after booking_service flips a row to `confirmed`. Never throws — the
 * notification path is best-effort and must not block the booking write.
 */
export async function onBookingConfirmed(bookingId: string): Promise<void> {
  try {
    await notifyBookingConfirmed(bookingId);
  } catch (err) {
    logger.warn({ err, bookingId }, 'on_booking_confirmed_hook_failed');
  }
}

/** Call after cancellation flow flips a row to `cancelled`. Never throws. */
export async function onBookingCancelled(bookingId: string): Promise<void> {
  try {
    await notifyBookingCancelled(bookingId);
  } catch (err) {
    logger.warn({ err, bookingId }, 'on_booking_cancelled_hook_failed');
  }
}
