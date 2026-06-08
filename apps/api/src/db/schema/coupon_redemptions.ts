import { pgEnum, pgTable, uuid } from 'drizzle-orm/pg-core';
import { bigintPaise, createdAt, uuidPk } from './_columns.js';
import { bookings } from './bookings.js';
import { coupons } from './coupons.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

/** Who absorbs the discount — recorded for audit/analytics. */
export const couponFunder = pgEnum('coupon_funder', ['org', 'platform']);

export const couponRedemptions = pgTable('coupon_redemptions', {
  id: uuidPk(),
  couponId: uuid('coupon_id')
    .notNull()
    .references(() => coupons.id),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id),
  userId: uuid('user_id').references(() => users.id),
  /** The org whose item was purchased. */
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  basePaise: bigintPaise('base_paise').notNull(),
  discountPaise: bigintPaise('discount_paise').notNull(),
  funder: couponFunder('funder').notNull(),
  createdAt: createdAt(),
});

export type CouponRedemption = typeof couponRedemptions.$inferSelect;
export type NewCouponRedemption = typeof couponRedemptions.$inferInsert;
