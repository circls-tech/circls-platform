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
 *
 * Every hook is best-effort and never throws: the notification path must not
 * block or roll back the write it follows. Call them after the write commits.
 */
import { logger } from '../lib/logger.js';
import {
  notifyBookingCancelled,
  notifyBookingConfirmed,
  notifyBookingRefunded,
  notifyBookingRescheduled,
  notifyCirclsSupportRequested,
  notifyEventCancelled,
  notifyListingReviewed,
  notifyListingSubmitted,
  notifyOrgCreated,
  notifyQuestionAsked,
  notifyQuestionReplied,
  type BookingCancelledOptions,
  type BookingRefundedInput,
  type ListingNotifyType,
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

/** Call after reschedule_service has moved a booking's slots (and committed).
 *  Tells the customer and re-queues their reminders. Never throws. */
export async function onBookingRescheduled(bookingId: string): Promise<void> {
  try {
    await notifyBookingRescheduled(bookingId);
  } catch (err) {
    logger.warn({ err, bookingId }, 'on_booking_rescheduled_hook_failed');
  }
}

/**
 * Call after a booking is cancelled (and committed). Revokes its QR tickets
 * and tells the customer — who cancelled, and the refund if one was issued
 * with it. Never throws.
 */
export async function onBookingCancelled(
  bookingId: string,
  opts: BookingCancelledOptions = {},
): Promise<void> {
  try {
    await revokeQrTicketsForBooking(bookingId);
  } catch (err) {
    logger.warn({ err, bookingId }, 'on_booking_cancelled_qr_revoke_failed');
  }
  try {
    await notifyBookingCancelled(bookingId, opts);
  } catch (err) {
    logger.warn({ err, bookingId }, 'on_booking_cancelled_hook_failed');
  }
}

/**
 * Call after a refund against a booking's charge is recorded (and, for
 * gateway refunds, accepted by the gateway). Tells the customer how much is
 * coming back, why and when. Failed refunds send nothing. Never throws.
 */
export async function onBookingRefunded(bookingId: string, refund: BookingRefundedInput): Promise<void> {
  if (refund.status === 'failed') return;
  try {
    await notifyBookingRefunded(bookingId, refund);
  } catch (err) {
    logger.warn({ err, bookingId }, 'on_booking_refunded_hook_failed');
  }
}

/**
 * Call after one or more events (or occurrences of a series) are cancelled.
 * Every customer still holding a confirmed booking for them is told; the
 * bookings themselves stay as they are — refunds are the organizer's call.
 * Never throws.
 */
export async function onEventCancelled(eventIds: string[]): Promise<void> {
  for (const eventId of eventIds) {
    try {
      await notifyEventCancelled(eventId);
    } catch (err) {
      logger.warn({ err, eventId }, 'on_event_cancelled_hook_failed');
    }
  }
}

/**
 * Call after a venue / arena / event / membership enters `pending_review`
 * (created straight into review, or a draft submitted). Alerts the Circls
 * admin team. Never throws.
 */
export async function onListingSubmitted(type: ListingNotifyType, id: string): Promise<void> {
  try {
    await notifyListingSubmitted(type, id);
  } catch (err) {
    logger.warn({ err, type, id }, 'on_listing_submitted_hook_failed');
  }
}

/**
 * Call after an admin approves or rejects a listing (committed). Tells the
 * owning org. Never throws.
 */
export async function onListingReviewed(
  type: ListingNotifyType,
  id: string,
  decision: 'approved' | 'rejected',
  reason?: string,
): Promise<void> {
  try {
    await notifyListingReviewed(type, id, decision, reason);
  } catch (err) {
    logger.warn({ err, type, id, decision }, 'on_listing_reviewed_hook_failed');
  }
}

/** Call after an org lets Circls into its portal. Alerts the Circls admin
 *  team. Never throws. */
export async function onCirclsSupportRequested(grantId: string): Promise<void> {
  try {
    await notifyCirclsSupportRequested(grantId);
  } catch (err) {
    logger.warn({ err, grantId }, 'on_circls_support_requested_hook_failed');
  }
}

/** Call after a new partner organisation is created. Alerts the Circls admin
 *  team. Never throws. */
export async function onOrgCreated(tenantId: string): Promise<void> {
  try {
    await notifyOrgCreated(tenantId);
  } catch (err) {
    logger.warn({ err, tenantId }, 'on_org_created_hook_failed');
  }
}
