import { boolean, integer, pgTable, uuid } from 'drizzle-orm/pg-core';
import { arenas } from './arenas.js';
import { bookingChannel } from './bookings.js';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';

/**
 * Explicit-column pricing rule. The engine picks the highest-priority rule whose
 * filters all match. NULL on a filter means "any". start_time_min/max are minutes
 * from midnight in venue-local time ([min, max)).
 */
export const pricingRules = pgTable('pricing_rules', {
  id: uuidPk(),
  arenaId: uuid('arena_id')
    .notNull()
    .references(() => arenas.id),
  priority: integer('priority').notNull().default(0),
  dayOfWeek: integer('day_of_week'), // 0=Sun..6=Sat, null=any
  startTimeMin: integer('start_time_min'), // inclusive, null=any
  startTimeMax: integer('start_time_max'), // exclusive, null=any
  channel: bookingChannel('channel'), // null=any
  memberOnly: boolean('member_only').notNull().default(false),
  pricePaise: bigintPaise('price_paise').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type PricingRule = typeof pricingRules.$inferSelect;
export type NewPricingRule = typeof pricingRules.$inferInsert;
