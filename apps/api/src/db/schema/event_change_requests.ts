import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, uuidPk } from './_columns.js';
import type { QrTicketConfig } from './qr_ticket_config.js';
import { events } from './events.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/**
 * A partner's proposed edit to a PUBLISHED event, awaiting circls review.
 * Free live edits (capacity increases, per-user limit, description, QR config,
 * registration questions) apply immediately and never create a row here; only
 * the approval-gated fields (name, window, location, tiers) do. A partial
 * unique index (`event_change_requests_pending_uq`) enforces at most one
 * pending request per event.
 */
export type EventChangeRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

/** A proposed tier row: `id` present = update that live tier in place,
 *  absent = add a new tier. Live tiers missing from the set are removals. */
export interface ChangeRequestTier {
  id?: string;
  name: string;
  description?: string | null;
  pricePaise: number;
  capacity?: number | null;
  qrTicketConfig?: QrTicketConfig | null;
}

/** The approval-gated fields; dates travel as ISO strings inside jsonb. */
export interface EventChangeRequestPatch {
  name?: string;
  startsAt?: string;
  endsAt?: string;
  venueId?: string | null;
  addressJson?: Record<string, unknown>;
  lat?: number | null;
  lng?: number | null;
  tzName?: string;
  tiers?: ChangeRequestTier[];
}

/** What the event looked like when the request was made — powers the admin's
 *  current→proposed diff and a "changed since requested" staleness note. */
export interface EventChangeRequestSnapshot {
  name?: string;
  startsAt?: string;
  endsAt?: string;
  venueId?: string | null;
  addressJson?: Record<string, unknown> | null;
  lat?: number | null;
  lng?: number | null;
  tzName?: string | null;
  tiers?: (ChangeRequestTier & { id: string })[];
}

export const eventChangeRequests = pgTable('event_change_requests', {
  id: uuidPk(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  requestedBy: uuid('requested_by')
    .notNull()
    .references(() => users.id),
  status: text('status').$type<EventChangeRequestStatus>().notNull().default('pending'),
  patch: jsonb('patch').$type<EventChangeRequestPatch>().notNull(),
  snapshot: jsonb('snapshot').$type<EventChangeRequestSnapshot>().notNull(),
  /** Reviewer's reject reason (optional). */
  reason: text('reason'),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type EventChangeRequest = typeof eventChangeRequests.$inferSelect;
export type NewEventChangeRequest = typeof eventChangeRequests.$inferInsert;
