import { integer, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tstzrange } from './bookings.js';
import { arenas } from './arenas.js';
import { tenants } from './tenants.js';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';

export const slotStatus = pgEnum('slot_status', ['open', 'held', 'blocked', 'booked']);

export const slotReleases = pgTable('slot_releases', {
  id: uuidPk(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  arenaId: uuid('arena_id').notNull().references(() => arenas.id),
  startDate: timestamp('start_date', { withTimezone: true }).notNull(),
  endDate: timestamp('end_date', { withTimezone: true }).notNull(),
  quantizationMin: integer('quantization_min').notNull(),
  createdAt: createdAt(),
});

export const slots = pgTable('slots', {
  id: uuidPk(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  arenaId: uuid('arena_id').notNull().references(() => arenas.id),
  timeRange: tstzrange('time_range').notNull(),
  pricePaise: bigintPaise('price_paise').notNull(),
  status: slotStatus('status').notNull().default('open'),
  // set when status='held'; null otherwise
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  // no FK reference: avoids circular dep with bookings (enforced at app level)
  bookingId: uuid('booking_id'),
  releaseId: uuid('release_id').references(() => slotReleases.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Slot = typeof slots.$inferSelect;
export type NewSlot = typeof slots.$inferInsert;

export type SlotRelease = typeof slotReleases.$inferSelect;
export type NewSlotRelease = typeof slotReleases.$inferInsert;
