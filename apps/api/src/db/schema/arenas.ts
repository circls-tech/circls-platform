import { sql } from 'drizzle-orm';
import { integer, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import { venues } from './venues.js';

/**
 * Last-used schedule-builder template, persisted per arena so the builder can
 * prefill it next time (the operator just changes the date range and releases).
 * `bands[].startMin`/`endMin` are minutes-from-midnight in venue wall-clock.
 */
export interface ScheduleTemplate {
  quantizationMin: number;
  defaultPriceRupees: number;
  bands: { startMin: number; endMin: number; priceRupees: number }[];
}

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
  // Minute-of-day at which this arena's *business day* begins (default 03:00).
  // Lets the schedule builder & reception grid treat e.g. a 4pm–2am window as a
  // single contiguous day instead of wrapping past calendar midnight.
  businessDayStartMin: integer('business_day_start_min').notNull().default(180),
  // Last-used builder template (bands + quantization + default price). See
  // ScheduleTemplate. Null until the first release.
  scheduleTemplate: jsonb('schedule_template').$type<ScheduleTemplate>(),
  // DB default stays 'active'; create service sets 'pending_review' (B).
  status: arenaStatus('status').notNull().default('active'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Arena = typeof arenas.$inferSelect;
export type NewArena = typeof arenas.$inferInsert;
