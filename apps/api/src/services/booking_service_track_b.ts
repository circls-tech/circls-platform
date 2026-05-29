/**
 * Track B add-ons to booking_service. Kept in a separate file so the Phase 12
 * subagent can edit freely without touching the existing booking_service.ts
 * surface that Track A relies on.
 *
 * Contract:
 *   - sweepAbandonedCarts(): worker handler. Cancels bookings stuck in 'pending'
 *     past the grace window (no payment captured), frees their slots, writes
 *     an audit row per booking.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLog, bookings, slots } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Cancel pending online-payment bookings that never got their webhook capture
 * within the grace window. Atomic per-booking inside a single transaction:
 *
 *   1. Flip the bookings row to 'cancelled' (returning the id so we know what
 *      we actually changed — the grace SELECT may race with handleRazorpayWebhook).
 *   2. Null out slots.booking_id for every linked slot, reopening them.
 *   3. Write `booking.abandoned_cart_cancelled` to the audit log.
 *
 * Returns the number of bookings cancelled. Worker-safe: re-runs are no-ops
 * because the WHERE clause filters on status='pending'.
 */
export async function sweepAbandonedCarts(): Promise<number> {
  const graceMin = env.ABANDONED_CART_GRACE_MIN;

  // We do the work in a single statement chain inside a transaction so a
  // concurrent webhook capture either:
  //   (a) wins first and flips the booking to confirmed — our UPDATE then
  //       finds zero rows, or
  //   (b) waits behind our row-lock and sees status='cancelled' after.
  return db.transaction(async (tx) => {
    const cancelled = await tx
      .update(bookings)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(bookings.status, 'pending'),
          eq(bookings.paymentMethod, 'razorpay_route'),
          sql`${bookings.createdAt} < now() - (${graceMin}::int * interval '1 minute')`,
        ),
      )
      .returning({ id: bookings.id, tenantId: bookings.tenantId });

    if (cancelled.length === 0) return 0;

    const ids = cancelled.map((b) => b.id);

    // Free the slots: clear booking_id and flip status back to open.
    await tx
      .update(slots)
      .set({
        status: 'open',
        bookingId: null,
        holdExpiresAt: null,
        heldByUserId: null,
      })
      .where(and(inArray(slots.bookingId, ids), sql`${slots.deletedAt} is null`));

    // One audit row per cancelled booking. No human actor — the sweep is
    // system-driven so actor_user_id is left null (audit_log allows it).
    await tx.insert(auditLog).values(
      cancelled.map((b) => ({
        tenantId: b.tenantId,
        action: 'booking.abandoned_cart_cancelled',
        entityType: 'booking',
        entityId: b.id,
      })),
    );

    logger.info({ count: cancelled.length }, 'abandoned_cart_sweep_cancelled');
    return cancelled.length;
  });
}
