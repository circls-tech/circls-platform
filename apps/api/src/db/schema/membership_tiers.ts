import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { memberships, type MembershipBenefits } from './memberships.js';
import { tenants } from './tenants.js';

/**
 * A purchasable plan tier within a Membership (e.g. Gold / Silver / Bronze).
 * Mirrors event ticket tiers: each tier carries its own price, duration, perks
 * (`benefits`, the same typed shape as a membership) and optional capacity
 * (null = unlimited). Per-tier sold counts are derived from
 * `user_memberships.membership_tier_id`, not stored here. Tiers are editable only
 * while the parent membership is editable (pending_review / inactive) via
 * replace-all, and are soft-deleted (deletedAt) when removed so existing buyers
 * keep referencing the tier they purchased.
 */
export const membershipTiers = pgTable('membership_tiers', {
  id: uuidPk(),
  membershipId: uuid('membership_id')
    .notNull()
    .references(() => memberships.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  description: text('description'),
  pricePaise: bigintPaise('price_paise').notNull().default(0),
  durationDays: integer('duration_days').notNull(),
  /** Typed perks for this tier; same shape as memberships.benefits. */
  benefits: jsonb('benefits').$type<MembershipBenefits>().notNull().default({ items: [] }),
  /** null = unlimited capacity for this tier. */
  capacity: integer('capacity'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type MembershipTier = typeof membershipTiers.$inferSelect;
export type NewMembershipTier = typeof membershipTiers.$inferInsert;
