import { sql } from 'drizzle-orm';
import { doublePrecision, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';

/** Physical location belonging to a Tenant. Geopoint as lat/lng (no PostGIS). */
export const venueStatus = pgEnum('venue_status', ['active', 'suspended']);

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
  status: venueStatus('status').notNull().default('active'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Venue = typeof venues.$inferSelect;
export type NewVenue = typeof venues.$inferInsert;
