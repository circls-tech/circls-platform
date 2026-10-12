import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import type { QrTicketConfig } from './qr_ticket_config.js';
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
 * The weekly plan auto-rollover releases from: the exact cells the partner
 * built (bands expanded, grid edits included), not just the band template, so
 * generated days match what they saw on the grid. `cells[].startTimeMin` is
 * minutes from the business day's local midnight and may exceed 1439
 * (overnight). Prices are minor units of the venue currency.
 */
export interface RolloverPlan {
  quantizationMin: number;
  businessDayStartMin: number;
  cells: {
    dayOfWeek: number;
    startTimeMin: number;
    durationMin: number;
    price?: number | null;
    blocked?: boolean;
  }[];
  /** Team member who saved the plan — auto-releases are audited as them. */
  savedByUserId: string;
  /** ISO-8601 instant the plan was saved. */
  savedAt: string;
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
  /** QR entry-ticket rules for bookings on this arena (null = disabled). */
  qrTicketConfig: jsonb('qr_ticket_config').$type<QrTicketConfig>(),
  // ── Auto-rollover (migration 0063). While enabled, the worker keeps the next
  //    ROLLOVER_HORIZON_DAYS business days released from `rolloverPlan`, only
  //    ever touching days that have no slots yet. See schedule_rollover_service.
  autoRolloverEnabled: boolean('auto_rollover_enabled').notNull().default(false),
  /** The saved weekly plan; kept when rollover is switched off so it can be
   *  switched back on without rebuilding. Null until first saved. */
  rolloverPlan: jsonb('rollover_plan').$type<RolloverPlan>(),
  /** When the plan or the enabled flag last changed. */
  rolloverUpdatedAt: timestamp('rollover_updated_at', { withTimezone: true }),
  /** Last time the worker checked this arena (whether or not it released). */
  rolloverLastRunAt: timestamp('rollover_last_run_at', { withTimezone: true }),
  // DB default stays 'active'; create service sets 'pending_review' (B).
  status: arenaStatus('status').notNull().default('active'),
  /** What the arena was before its partner closed it (closed = `suspended`);
   *  reopening restores it. Null while open. See migration 0053. */
  statusBeforeClose: arenaStatus('status_before_close'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Arena = typeof arenas.$inferSelect;
export type NewArena = typeof arenas.$inferInsert;
