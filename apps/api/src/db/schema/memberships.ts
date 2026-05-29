import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { payments } from './payments.js';
import { tenants } from './tenants.js';
import { users } from './users.js';
import { venues } from './venues.js';

/**
 * Memberships (Phase 15). A Tenant publishes Memberships scoped to the tenant
 * or a specific venue. Users buy them and gain time-bound benefits (e.g. priority
 * booking, free slots/month). Free memberships skip KYC; paid ones require it.
 */
// Listing-approval lifecycle: `pending_review` → `active` ⇄ `inactive`; or `rejected`.
export const membershipStatus = pgEnum('membership_status', [
  'pending_review',
  'active',
  'inactive',
  'rejected',
]);

export const memberships = pgTable('memberships', {
  id: uuidPk(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  /** Null = tenant-wide. */
  venueId: uuid('venue_id').references(() => venues.id),
  name: text('name').notNull(),
  description: text('description'),
  pricePaise: bigintPaise('price_paise').notNull().default(0),
  durationDays: integer('duration_days').notNull(),
  benefits: jsonb('benefits').$type<Record<string, unknown>>().notNull().default({}),
  // DB default stays 'active'; create service sets 'pending_review' (B).
  status: membershipStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;

export const userMembershipStatus = pgEnum('user_membership_status', [
  'active',
  'expired',
  'cancelled',
]);

export const userMemberships = pgTable('user_memberships', {
  id: uuidPk(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  membershipId: uuid('membership_id')
    .notNull()
    .references(() => memberships.id),
  paymentId: uuid('payment_id').references(() => payments.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  status: userMembershipStatus('status').notNull().default('active'),
  createdAt: createdAt(),
});

export type UserMembership = typeof userMemberships.$inferSelect;
export type NewUserMembership = typeof userMemberships.$inferInsert;
