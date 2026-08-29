import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { payments } from './payments.js';
import type { QrTicketConfig } from './qr_ticket_config.js';
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

/**
 * Typed membership benefits (PR #110). Replaces the opaque jsonb blob with an
 * ordered list of labelled perks; `detail` is an optional secondary line. The
 * `MembershipBenefits` wrapper keeps the column extensible (e.g. future
 * grouping) without another migration.
 */
export interface MembershipBenefitItem {
  label: string;
  detail?: string;
}
export interface MembershipBenefits {
  items: MembershipBenefitItem[];
}

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
  /** Typed list of perks ({ items: [...] }); see MembershipBenefits + the
   *  coercion helper in lib/membership_benefits.ts. */
  benefits: jsonb('benefits').$type<MembershipBenefits>().notNull().default({ items: [] }),
  /** Optional plan terms & conditions (free text). */
  terms: text('terms'),
  /** R2 object key of the single cover/artwork image; public URL derived at the
   *  service layer (finalized via presign+HEAD like venue images). */
  coverStorageKey: text('cover_storage_key'),
  /** QR entry-ticket rules for purchases of this plan (null = disabled). */
  qrTicketConfig: jsonb('qr_ticket_config').$type<QrTicketConfig>(),
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
  /**
   * Null for a member the partner added by hand, who has no circls account —
   * their identity lives in externalName/externalContact instead. A DB CHECK
   * (`user_memberships_member_identity_chk`) requires one or the other, so a
   * row can never be anonymous. Mirrors bookings' customerUserId.
   */
  userId: uuid('user_id').references(() => users.id),
  membershipId: uuid('membership_id')
    .notNull()
    .references(() => memberships.id),
  /**
   * The tier the buyer purchased (null for legacy purchases predating tiers).
   * Drives per-tier sold/capacity counts. Not an FK so a soft-deleted tier can
   * still be referenced historically.
   */
  membershipTierId: uuid('membership_tier_id'),
  paymentId: uuid('payment_id').references(() => payments.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  status: userMembershipStatus('status').notNull().default('active'),
  /** Set only when userId is null: who the partner recorded. */
  externalName: text('external_name'),
  /** Phone or email for an externally-added member, when one was captured. */
  externalContact: text('external_contact'),
  /** The partner who recorded this member; null for consumer purchases. */
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  createdAt: createdAt(),
});

export type UserMembership = typeof userMemberships.$inferSelect;
export type NewUserMembership = typeof userMemberships.$inferInsert;
