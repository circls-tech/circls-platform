/**
 * Track B add-ons to booking_service. Kept in a separate file so the Phase 12
 * subagent can edit freely without touching the existing booking_service.ts
 * surface that Track A relies on.
 *
 * Contract:
 *   - sweepAbandonedCarts(): worker handler. Cancels bookings stuck in 'pending'
 *     past the grace window (no payment captured), frees their slots, writes
 *     an audit row per booking. The sweep is the SOLE canceller of unpaid
 *     pending bookings — a gateway "payment failed" webhook records the
 *     attempt but never cancels (the customer can retry in the still-open
 *     card form; see payments_service.applyPaymentFailed).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLog, bookings, payments, slots } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { getGateway } from '../lib/gateway.js';
import { logger } from '../lib/logger.js';

/**
 * Cancel pending online-payment bookings that never got their webhook capture
 * within the grace window. Atomic per-booking inside a single transaction:
 *
 *   1. Flip the bookings row to 'cancelled' (returning the id so we know what
 *      we actually changed — the grace SELECT may race with handleRazorpayWebhook).
 *   2. Null out slots.booking_id for every linked slot, reopening them.
 *   3. Flip the bookings' still-pending charge rows to 'failed' so a late
 *      capture is routed to the auto-refund safety net instead of confirming.
 *   4. Write `booking.abandoned_cart_cancelled` to the audit log.
 *
 * After the transaction commits, cancel the gateway orders (best-effort) so
 * the customer's still-open payment form can no longer complete the charge.
 * Stripe supports this; Razorpay has no order-cancel API (adapter no-op) —
 * for Razorpay the safety net is the only protection.
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
  const { count, ordersToCancel } = await db.transaction(async (tx) => {
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

    if (cancelled.length === 0) return { count: 0, ordersToCancel: [] };

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

    // Terminally fail the never-captured charges. Status-guarded: a charge a
    // concurrent webhook already captured is left alone (that booking wasn't
    // in our cancelled set anyway — the capture confirmed it first or is
    // blocked behind our booking row-lock and will hit the safety net).
    const failedCharges = await tx
      .update(payments)
      .set({ status: 'failed' })
      .where(
        and(
          inArray(payments.bookingId, ids),
          eq(payments.kind, 'charge'),
          eq(payments.status, 'pending'),
        ),
      )
      .returning({
        id: payments.id,
        provider: payments.provider,
        providerOrderId: payments.providerOrderId,
      });

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

    logger.info(
      { count: cancelled.length, failedCharges: failedCharges.length },
      'abandoned_cart_sweep_cancelled',
    );
    return { count: cancelled.length, ordersToCancel: failedCharges };
  });

  // Cancel the gateway orders AFTER the tx commits — network calls don't
  // belong inside the row-locked transaction, and a gateway error must not
  // roll back the cancellation. Best-effort per order: a failure (e.g. the
  // intent already succeeded because a retry-capture won) is logged and left
  // to the capture safety net.
  for (const charge of ordersToCancel) {
    if (charge.provider !== 'razorpay' && charge.provider !== 'stripe') continue; // stub/external
    if (!charge.providerOrderId) continue;
    try {
      await getGateway(charge.provider).cancelOrder(charge.providerOrderId);
    } catch (err) {
      logger.error(
        { err, paymentId: charge.id, provider: charge.provider, orderId: charge.providerOrderId },
        'abandoned_cart_gateway_cancel_failed',
      );
    }
  }

  return count;
}
