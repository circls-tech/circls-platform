import { customType, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { arenas } from './arenas.js';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';
import { venues } from './venues.js';

/** Postgres `tstzrange`, carried as its text form, e.g. `["2026-..","2026-..")`. */
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange';
  },
});

export const bookingItemType = pgEnum('booking_item_type', ['slot', 'event', 'membership']);
export const bookingChannel = pgEnum('booking_channel', [
  'circls',
  'aggregator',
  'venue_site',
  'walkin',
]);
export const bookingPaymentMethod = pgEnum('booking_payment_method', [
  'razorpay_route',
  'external',
  'free',
]);
export const bookingStatus = pgEnum('booking_status', [
  'pending',
  'confirmed',
  'cancelled',
  'completed',
  'no_show',
]);

/**
 * Unified ledger row for any bookable item. The inventory invariant lives in the
 * DB: a GIST exclusion constraint (added in the migration, needs btree_gist)
 * forbids two non-cancelled slot bookings whose time_range overlaps on the same
 * arena. See migration 0003.
 */
export const bookings = pgTable('bookings', {
  id: uuidPk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  venueId: uuid('venue_id').references(() => venues.id),
  itemType: bookingItemType('item_type').notNull(),
  slotArenaId: uuid('slot_arena_id').references(() => arenas.id),
  timeRange: tstzrange('time_range'),
  channel: bookingChannel('channel').notNull(),
  paymentMethod: bookingPaymentMethod('payment_method').notNull(),
  status: bookingStatus('status').notNull().default('pending'),
  itemData: jsonb('item_data').$type<Record<string, unknown>>(),
  pricePaise: bigintPaise('price_paise'),
  customerUserId: uuid('customer_user_id').references(() => users.id),
  customerContactJson: jsonb('customer_contact_json').$type<Record<string, unknown>>(),
  customerName: text('customer_name'),
  customerContact: text('customer_contact'),
  note: text('note'),
  totalPaise: bigintPaise('total_paise'),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
