import { integer, pgTable, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, uuidPk } from './_columns.js';
import { bookings } from './bookings.js';
import { eventTicketTiers } from './event_ticket_tiers.js';

/**
 * Line item linking one booking to one ticket tier with a quantity (Phase:
 * ticket tiers). A single event booking is still ONE bookings row; its tier
 * breakdown is the set of these lines. This table is the SOLE source of per-tier
 * sold counts: SUM(quantity) over lines whose booking is not cancelled.
 */
export const eventBookingTickets = pgTable('event_booking_tickets', {
  id: uuidPk(),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id, { onDelete: 'cascade' }),
  tierId: uuid('tier_id')
    .notNull()
    .references(() => eventTicketTiers.id),
  quantity: integer('quantity').notNull(),
  /** Price per ticket at purchase time (snapshot; tier price may change later). */
  unitPricePaise: bigintPaise('unit_price_paise').notNull(),
  createdAt: createdAt(),
});

export type EventBookingTicket = typeof eventBookingTickets.$inferSelect;
export type NewEventBookingTicket = typeof eventBookingTickets.$inferInsert;
