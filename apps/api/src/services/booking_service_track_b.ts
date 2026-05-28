/**
 * Track B add-ons to booking_service. Kept in a separate file so the Phase 12
 * subagent can edit freely without touching the existing booking_service.ts
 * surface that Track A relies on.
 *
 * Contract:
 *   - sweepAbandonedCarts(): worker handler. Cancels bookings stuck in 'pending'
 *     past the grace window (no payment captured), frees their slots.
 */
import { logger } from '../lib/logger.js';

export async function sweepAbandonedCarts(): Promise<number> {
  // TODO(phase-12): SELECT bookings WHERE status='pending' AND
  // created_at < now() - ABANDONED_CART_GRACE_MIN minutes;
  // for each: set status='cancelled', null the slot.booking_id, free slot.
  logger.debug('abandoned_cart_sweep_stub');
  return 0;
}
