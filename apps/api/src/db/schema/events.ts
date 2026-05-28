import { integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { arenas } from './arenas.js';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';
import { venues } from './venues.js';

/**
 * Venue-level Events (Phase 15). An Event uses one or more Arenas during a
 * single window. Bookings of `item_type='event'` reference it via item_data.
 */
export const eventStatus = pgEnum('event_status', ['draft', 'published', 'cancelled']);

export const events = pgTable('events', {
  id: uuidPk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  venueId: uuid('venue_id')
    .notNull()
    .references(() => venues.id),
  name: text('name').notNull(),
  description: text('description'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  pricePaise: bigintPaise('price_paise').notNull().default(0),
  capacity: integer('capacity'),
  status: eventStatus('status').notNull().default('draft'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

/** Many-to-many: an event may occupy several arenas during its window. */
export const eventArenas = pgTable(
  'event_arenas',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    arenaId: uuid('arena_id')
      .notNull()
      .references(() => arenas.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.arenaId] }),
  })
);

export type EventArena = typeof eventArenas.$inferSelect;
export type NewEventArena = typeof eventArenas.$inferInsert;
