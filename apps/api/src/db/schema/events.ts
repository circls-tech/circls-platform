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
import type { PostBookingRedirect } from './post_booking_redirect.js';
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
//
// `completed` is the partner ending a live event early — it ran (or is over)
// and should stop selling before its scheduled `ends_at`. Also terminal, and
// deliberately distinct from `cancelled`, which implies the event did not
// happen. Neither refunds anything on its own.
export const eventStatus = pgEnum('event_status', [
  'draft',
  'pending_review',
  'published',
  'cancelled',
  'rejected',
  'completed',
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
   * Where to send the customer once their booking is confirmed — a partner's
   * registration form, community chat, or waiver (null = nothing to show).
   * Never part of the public event payload: it's delivered with the booking,
   * so an unbooked visitor can't lift a private group invite off the listing.
   */
  postBookingRedirect: jsonb('post_booking_redirect').$type<PostBookingRedirect>(),
  /**
   * Groups the occurrences of a recurring event ("every Thu & Fri until …").
   * Each occurrence is a full row (own window/scope/tiers/bookings/status);
   * series_id only ties them together. Null = one-off event.
   */
  seriesId: uuid('series_id'),
  // ── Per-event billing overrides (admin-only). NULL = inherit the tenant's
  // rate; 0 = explicitly disabled for this event. See tenants billing knobs.
  partnerCommissionBps: integer('partner_commission_bps'),
  consumerCommissionBps: integer('consumer_commission_bps'),
  advancePayoutBps: integer('advance_payout_bps'),
  status: eventStatus('status').notNull().default('draft'),
  /**
   * Partner-side shelving: non-null hides the event from their default list.
   * Orthogonal to `status` on purpose — a cancelled, rejected, completed or
   * abandoned draft event can all be archived without losing why it ended that
   * way. Never consulted by a consumer query.
   */
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  /**
   * Set when the lifecycle sweep archived this event rather than a partner.
   * The sweep only acts on rows where this is null, so it shelves an event at
   * most once and a partner who restores one is not overruled next hour.
   */
  autoArchivedAt: timestamp('auto_archived_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
