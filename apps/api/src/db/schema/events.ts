import {
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';
import { venues } from './venues.js';

/**
 * Venue-level Events (Phase 15, venue-scoped per subproject C). An Event is an
 * offering at a venue during a single window — NOT bound to specific arenas (the
 * `event_arenas` join was dropped in C). Bookings of `item_type='event'`
 * reference it via item_data; capacity is a seat count enforced at booking time.
 */
// Listing-approval lifecycle: `draft` → (partner submits) `pending_review` →
// (admin) `published` (approved + live) / `rejected`; `cancelled` is terminal.
export const eventStatus = pgEnum('event_status', [
  'draft',
  'pending_review',
  'published',
  'cancelled',
  'rejected',
]);

export const events = pgTable('events', {
  id: uuidPk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  /** Null = org-scoped (venue-less). Mirrors memberships' nullable venue_id. */
  venueId: uuid('venue_id').references(() => venues.id),
  // Standalone-event location (set only when venueId is null; venue events read
  // their location from the venue). DB CHECK `events_scope_chk` enforces this.
  addressJson: jsonb('address_json').$type<Record<string, unknown>>(),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  tzName: text('tz_name'),
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
