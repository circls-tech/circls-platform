import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { events } from './events.js';
import type { QrTicketConfig } from './qr_ticket_config.js';
import { tenants } from './tenants.js';

/**
 * A purchasable ticket tier within an event (Phase: ticket tiers). Each tier has
 * its own price and its own capacity (null = unlimited). Per-tier sold counts are
 * derived from event_booking_tickets, not stored here. Tiers are editable only
 * while the parent event is draft (replace-all from the event payload), and are
 * soft-deleted (deletedAt) when removed so historical bookings keep referencing
 * the tier they were sold under.
 */
export const eventTicketTiers = pgTable('event_ticket_tiers', {
  id: uuidPk(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  pricePaise: bigintPaise('price_paise').notNull().default(0),
  /** null = unlimited capacity for this tier. */
  capacity: integer('capacity'),
  /** Per-tier QR entry-ticket override. null = inherit the event's config;
   *  `{ enabled: false }` = QR off for this tier even when the event enables
   *  it; an enabled config replaces the event's rules wholesale. */
  qrTicketConfig: jsonb('qr_ticket_config').$type<QrTicketConfig>(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type EventTicketTier = typeof eventTicketTiers.$inferSelect;
export type NewEventTicketTier = typeof eventTicketTiers.$inferInsert;
