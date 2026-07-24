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
import type { QrTicketConfig } from './qr_ticket_config.js';
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

// Who can find/enter the event once published: `public` = normal discovery;
// `unlisted` = hidden from all consumer listings, reachable only by direct
// link; `access_code` = listed (badged "invite only") but tiers/booking stay
// locked until the consumer presents the event's access code.
export const eventVisibility = pgEnum('event_visibility', [
  'public',
  'unlisted',
  'access_code',
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
  /** Per-customer ticket cap for the whole event (summed across all tiers and
   *  all the user's non-cancelled bookings); null = no limit. */
  maxPerUser: integer('max_per_user'),
  /** QR entry-ticket rules for this event (null = QR tickets disabled). */
  qrTicketConfig: jsonb('qr_ticket_config').$type<QrTicketConfig>(),
  /**
   * Groups the occurrences of a recurring event ("every Thu & Fri until …").
   * Each occurrence is a full row (own window/scope/tiers/bookings/status);
   * series_id only ties them together. Null = one-off event.
   */
  seriesId: uuid('series_id'),
  visibility: eventVisibility('visibility').notNull().default('public'),
  /** Entry code for `visibility='access_code'` events (compared trimmed,
   *  case-insensitively). Partner-visible; NEVER included in consumer payloads.
   *  DB CHECK `events_access_code_chk` requires it for access_code events. */
  accessCode: text('access_code'),
  status: eventStatus('status').notNull().default('draft'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type EventVisibility = (typeof eventVisibility.enumValues)[number];
