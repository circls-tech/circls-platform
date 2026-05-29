import { sql } from 'drizzle-orm';
import { integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import { venues } from './venues.js';

/**
 * Bookable resource within a Venue (court, pool, hall, …).
 *
 * Listing-approval lifecycle mirrors venues: `pending_review` → `active` ⇄
 * `suspended`; or `rejected`.
 */
export const arenaStatus = pgEnum('arena_status', [
  'pending_review',
  'active',
  'suspended',
  'rejected',
]);

export const arenas = pgTable('arenas', {
  id: uuidPk(),
  venueId: uuid('venue_id')
    .notNull()
    .references(() => venues.id),
  name: text('name').notNull(),
  sport: text('sport'),
  capacity: integer('capacity'),
  slotDurationMin: integer('slot_duration_min').notNull().default(60),
  status: arenaStatus('status').notNull().default('pending_review'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Arena = typeof arenas.$inferSelect;
export type NewArena = typeof arenas.$inferInsert;
