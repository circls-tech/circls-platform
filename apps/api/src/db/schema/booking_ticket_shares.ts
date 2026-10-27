import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, uuidPk } from './_columns.js';
import { users } from './users.js';

/**
 * A ticket a customer has handed to a friend ("Share booking"): one row per
 * QR ticket shared, carrying the link token the friend opens. Once the friend
 * accepts, the booking shows in their My Bookings with that ticket's QR (and
 * only that one); the customer keeps seeing every ticket and stays the only
 * one who can cancel.
 *
 * Event and court bookings only (memberships are personal). An accepted share
 * is final; a link nobody has accepted can be withdrawn. At most one live
 * (not withdrawn) share per ticket, enforced by a partial unique index in the
 * migration.
 *
 * `booking_id` and `qr_ticket_id` have no FK here (the migration adds them),
 * keeping this file free of cycles, like `qr_tickets.booking_id`.
 */
export const bookingTicketShares = pgTable('booking_ticket_shares', {
  id: uuidPk(),
  bookingId: uuid('booking_id').notNull(),
  qrTicketId: uuid('qr_ticket_id').notNull(),
  /** Opaque random token in the share link (base64url, unique). */
  token: text('token').notNull().unique(),
  /** The booking's customer, who shared it. */
  sharedByUserId: uuid('shared_by_user_id')
    .notNull()
    .references(() => users.id),
  /** The friend who accepted it; null until then. */
  claimedByUserId: uuid('claimed_by_user_id').references(() => users.id),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  /** Set when the customer withdrew the link before anyone accepted it. */
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export type BookingTicketShare = typeof bookingTicketShares.$inferSelect;
