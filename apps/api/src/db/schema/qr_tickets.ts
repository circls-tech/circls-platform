import { boolean, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import { bookingItemType } from './bookings.js';
import { tenants } from './tenants.js';

/**
 * Issued QR tickets. One row per scannable ticket, minted when the purchase is
 * finalised (booking flips to `confirmed`, or a free membership is activated)
 * and only for listings whose `qr_ticket_config.enabled` is true:
 *
 *   - event bookings: one ticket per seat (a 3-seat booking gets 3 rows);
 *   - slot bookings: one ticket per arena within the booking, spanning that
 *     arena's booked slots;
 *   - membership purchases: one ticket per user_membership.
 *
 * `code` is an opaque random token — the QR encodes a partner-portal check-in
 * URL carrying it; validation is always an online lookup, so no signing is
 * needed. Scan rules (multi_use / max_scans) and the concrete validity window
 * are frozen onto the row at issuance so later config edits don't mutate
 * already-sold tickets.
 */
export const qrTicketStatus = pgEnum('qr_ticket_status', ['active', 'used', 'revoked']);

export const qrTickets = pgTable('qr_tickets', {
  id: uuidPk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  /** The confirmed booking this ticket admits (null only for the free-membership
   *  path, which has no bookings row). No FK: mirrors slots.booking_id — the SQL
   *  migration adds the constraint, keeping this file cycle-free. */
  bookingId: uuid('booking_id'),
  /** Set for membership tickets (with or without a synthetic booking). */
  userMembershipId: uuid('user_membership_id'),
  itemType: bookingItemType('item_type').notNull(),
  /** Door-staff label: tier name, arena name, or membership (+ tier) name. */
  label: text('label'),
  /** Opaque random token embedded in the QR (base64url, unique). */
  code: text('code').notNull().unique(),
  /** null = valid as soon as issued. */
  validFrom: timestamp('valid_from', { withTimezone: true }),
  /** null = never expires (uncapped window). */
  validUntil: timestamp('valid_until', { withTimezone: true }),
  multiUse: boolean('multi_use').notNull().default(false),
  /** Scan cap for multi-use tickets; null = unlimited. */
  maxScans: integer('max_scans'),
  scanCount: integer('scan_count').notNull().default(0),
  firstScannedAt: timestamp('first_scanned_at', { withTimezone: true }),
  lastScannedAt: timestamp('last_scanned_at', { withTimezone: true }),
  status: qrTicketStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type QrTicket = typeof qrTickets.$inferSelect;
export type NewQrTicket = typeof qrTickets.$inferInsert;
