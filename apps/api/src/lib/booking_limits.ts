/**
 * Hard ceilings on what one booking request may claim.
 *
 * They bound the work a single call can cause — slots locked under an unpaid
 * booking, seats summed per tier, QR tickets minted per seat — and sit far
 * above any real cart or group purchase. Enforced at the route schemas (a
 * clean 400) and again in the booking service, which every caller — consumer
 * checkout, partner desk, aggregator — passes through.
 */

/** Most court slots one checkout may book. */
export const MAX_SLOTS_PER_BOOKING = 20;

/**
 * Most court slots one customer may hold under bookings that are still unpaid
 * (`status = 'pending'`, waiting on the gateway). Those slots stay off sale
 * until the abandoned-cart sweep frees them, so without this cap one account
 * could take a venue's whole open inventory off sale just by starting
 * checkouts it never finishes.
 */
export const MAX_PENDING_SLOTS_PER_USER = 20;

/** Most ticket-tier lines in one event booking (an event has at most 20 tiers). */
export const MAX_LINES_PER_EVENT_BOOKING = 20;

/** Most tickets of one tier in one booking — the partner's off-platform registration form has the same cap. */
export const MAX_TICKETS_PER_LINE = 100;

/** Most tickets, across every tier, in one booking. */
export const MAX_TICKETS_PER_BOOKING = 100;
