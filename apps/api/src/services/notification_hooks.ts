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
  notifyQuestionAsked,
  notifyQuestionReplied,
} from './notification_service.js';
import {
  issueQrTicketsForBooking,
  revokeQrTicketsForBooking,
} from './qr_ticket_service.js';

/**
 * Call after booking_service flips a row to `confirmed`. Never throws — the
 * notification path is best-effort and must not block the booking write.
 */
export async function onBookingConfirmed(bookingId: string): Promise<void> {
  try {
    // Idempotent — the paid path already issues inside the capture webhook tx.
    await issueQrTicketsForBooking(bookingId);
  } catch (err) {
    logger.warn({ err, bookingId }, 'on_booking_confirmed_qr_issue_failed');
  }
  try {
    await notifyBookingConfirmed(bookingId);
  } catch (err) {
    logger.warn({ err, bookingId }, 'on_booking_confirmed_hook_failed');
  }
}

/**
 * Call after a question thread is created (thread + root message committed).
 * Emails the owning org's contact_email. Never throws.
 */
export async function onQuestionAsked(threadId: string): Promise<void> {
  try {
    await notifyQuestionAsked(threadId);
  } catch (err) {
    logger.warn({ err, threadId }, 'on_question_asked_hook_failed');
  }
}

/**
 * Call after an org/Circls reply lands on a question thread. Emails the
 * thread author. Never throws.
 */
export async function onQuestionReplied(threadId: string, messageId: string): Promise<void> {
  try {
    await notifyQuestionReplied(threadId, messageId);
  } catch (err) {
    logger.warn({ err, threadId, messageId }, 'on_question_replied_hook_failed');
  }
}

/** Call after cancellation flow flips a row to `cancelled`. Never throws. */
export async function onBookingCancelled(bookingId: string): Promise<void> {
  try {
    await revokeQrTicketsForBooking(bookingId);
  } catch (err) {
    logger.warn({ err, bookingId }, 'on_booking_cancelled_qr_revoke_failed');
  }
  try {
    await notifyBookingCancelled(bookingId);
  } catch (err) {
    logger.warn({ err, bookingId }, 'on_booking_cancelled_hook_failed');
  }
}
