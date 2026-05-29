import { sql } from 'drizzle-orm';
import { doublePrecision, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';

/**
 * Physical location belonging to a Tenant. Geopoint as lat/lng (no PostGIS).
 *
 * Listing-approval lifecycle: created `pending_review` → admin `active`
 * (approved + live) ⇄ `suspended` (operational); or `rejected`. Consumers
 * only see `active` venues whose tenant is not suspended.
 */
export const venueStatus = pgEnum('venue_status', [
  'pending_review',
  'active',
  'suspended',
  'rejected',
]);

export const venues = pgTable('venues', {
  id: uuidPk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  addressJson: jsonb('address_json').$type<Record<string, unknown>>(),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  // IANA tz for rendering slots in venue-local time on the frontend.
  tzName: text('tz_name').notNull().default('Asia/Kolkata'),
  // DB default stays the legacy 'active' (matches grandfathered rows); the
  // create service sets 'pending_review' explicitly for new listings (B).
  status: venueStatus('status').notNull().default('active'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Venue = typeof venues.$inferSelect;
export type NewVenue = typeof venues.$inferInsert;
