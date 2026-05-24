import { bigint, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tstzrange } from './bookings.js';
import { arenas } from './arenas.js';
import { tenants } from './tenants.js';
import { createdAt, updatedAt, uuidPk } from './_columns.js';

export const slotStatus = pgEnum('slot_status', ['open', 'held', 'blocked', 'booked']);

export const slotReleases = pgTable('slot_releases', {
  id: uuidPk(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  arenaId: uuid('arena_id').notNull().references(() => arenas.id),
  startDate: timestamp('start_date', { withTimezone: true }).notNull(),
  endDate: timestamp('end_date', { withTimezone: true }).notNull(),
  quantizationMin: bigint('quantization_min', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
});

export const slots = pgTable('slots', {
  id: uuidPk(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  arenaId: uuid('arena_id').notNull().references(() => arenas.id),
  timeRange: tstzrange('time_range').notNull(),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  status: slotStatus('status').notNull().default('open'),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  bookingId: uuid('booking_id'),
  releaseId: uuid('release_id').references(() => slotReleases.id),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Slot = typeof slots.$inferSelect;
export type NewSlot = typeof slots.$inferInsert;
