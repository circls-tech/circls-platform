import { sql } from 'drizzle-orm';
import { doublePrecision, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';

/**
 * Per-weekday opening hours (PR #109). Keys are weekday indices "0"–"6" with
 * 0 = Sunday. Each day holds zero or more open/close ranges ("HH:MM", venue-
 * local); an empty array (or a missing key) means the venue is closed that day.
 */
export type VenueOpeningHours = Record<string, { open: string; close: string }[]>;

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
  // ── Trust metadata (PR #109). All nullable; editable by owner/manager via
  //    PATCH /v1/venues/:id and surfaced in the consumer venue payload.
  description: text('description'),
  /** Canonical facility tags (see VENUE_AMENITIES). */
  amenities: text('amenities').array().notNull().default(sql`'{}'::text[]`),
  /** Per-weekday open/close ranges; see VenueOpeningHours. */
  openingHours: jsonb('opening_hours').$type<VenueOpeningHours>(),
  contactPhone: text('contact_phone'),
  contactEmail: text('contact_email'),
  /** Structured postal address (supersedes the unstructured address_json). */
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  state: text('state'),
  postalCode: text('postal_code'),
  country: text('country'),
  // DB default stays the legacy 'active' (matches grandfathered rows); the
  // create service sets 'pending_review' explicitly for new listings (B).
  status: venueStatus('status').notNull().default('active'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Venue = typeof venues.$inferSelect;
export type NewVenue = typeof venues.$inferInsert;
