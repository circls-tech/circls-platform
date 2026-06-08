import { bigint, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, updatedAt, uuidPk } from './_columns.js';
import { tenants } from './tenants.js';

/** Who created the coupon. Platform coupons are Circls-funded; tenant coupons org-funded. */
export const couponOwnerType = pgEnum('coupon_owner_type', ['platform', 'tenant']);
/** A coupon targets exactly one scope. `org` = whole owner; others use scope_id. */
export const couponScopeType = pgEnum('coupon_scope_type', [
  'org',
  'venue',
  'event',
  'arena',
  'membership',
]);
export const couponDiscountType = pgEnum('coupon_discount_type', ['percent', 'fixed']);
/** public = listable at checkout; private = must be typed. */
export const couponVisibility = pgEnum('coupon_visibility', ['public', 'private']);
export const couponStatus = pgEnum('coupon_status', ['active', 'paused', 'expired']);

export const coupons = pgTable('coupons', {
  id: uuidPk(),
  ownerType: couponOwnerType('owner_type').notNull(),
  /** Set for tenant-owned; null for platform-owned. */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  description: text('description'),
  scopeType: couponScopeType('scope_type').notNull(),
  /** venue/event/arena/membership id; null for `org` and platform-wide scope. */
  scopeId: uuid('scope_id'),
  discountType: couponDiscountType('discount_type').notNull(),
  /** Basis points when percent; paise when fixed. */
  discountValue: bigint('discount_value', { mode: 'number' }).notNull(),
  maxDiscountPaise: bigintPaise('max_discount_paise'),
  minOrderPaise: bigintPaise('min_order_paise'),
  visibility: couponVisibility('visibility').notNull().default('private'),
  validFrom: timestamp('valid_from', { withTimezone: true }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  maxRedemptions: integer('max_redemptions'),
  perUserLimit: integer('per_user_limit'),
  redeemedCount: integer('redeemed_count').notNull().default(0),
  status: couponStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type Coupon = typeof coupons.$inferSelect;
export type NewCoupon = typeof coupons.$inferInsert;
