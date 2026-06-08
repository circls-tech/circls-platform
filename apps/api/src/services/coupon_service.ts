/**
 * Coupon service — CRUD (added later) plus the validation + resolution used at
 * checkout. `validateCoupon` is pure (no DB) so the constraint logic is unit
 * tested directly; the per-user redemption count + code resolution that need
 * the DB live in `resolveCouponForCheckout` (added with the CRUD).
 */
import type { Coupon } from '../db/schema/coupons.js';

/** The item being purchased, used for scope matching. */
export interface CheckoutItem {
  type: 'slot' | 'event' | 'arena' | 'membership';
  /** The event/membership id, or the arena id for a slot booking. */
  id: string;
  /** The venue the item belongs to, if any (null for org-scoped events). */
  venueId: string | null;
}

export interface CouponValidationContext {
  basePaise: number;
  now: Date;
  item: CheckoutItem;
}

export type CouponErrorCode =
  | 'coupon_not_found'
  | 'coupon_inactive'
  | 'coupon_not_started'
  | 'coupon_expired'
  | 'coupon_scope_mismatch'
  | 'coupon_min_order'
  | 'coupon_max_redeemed'
  | 'coupon_user_limit';

export type CouponValidationResult = { ok: true } | { ok: false; code: CouponErrorCode };

/** Does this coupon's scope cover the item being purchased? */
export function couponMatchesItem(coupon: Coupon, item: CheckoutItem): boolean {
  switch (coupon.scopeType) {
    case 'org':
      return true; // owner-wide (tenant) or platform-wide
    case 'venue':
      return item.venueId != null && item.venueId === coupon.scopeId;
    case 'arena':
      return item.type === 'slot' && item.id === coupon.scopeId;
    case 'event':
      return item.type === 'event' && item.id === coupon.scopeId;
    case 'membership':
      return item.type === 'membership' && item.id === coupon.scopeId;
    default:
      return false;
  }
}

/**
 * Pure constraint check: status, window, scope, min-order, total-cap. Does NOT
 * check the per-user limit (needs a DB count — done in resolveCouponForCheckout).
 */
export function validateCoupon(
  coupon: Coupon,
  ctx: CouponValidationContext,
): CouponValidationResult {
  if (coupon.status !== 'active') return { ok: false, code: 'coupon_inactive' };
  if (coupon.validFrom && ctx.now < coupon.validFrom) return { ok: false, code: 'coupon_not_started' };
  if (coupon.validUntil && ctx.now > coupon.validUntil) return { ok: false, code: 'coupon_expired' };
  if (!couponMatchesItem(coupon, ctx.item)) return { ok: false, code: 'coupon_scope_mismatch' };
  if (coupon.minOrderPaise != null && ctx.basePaise < coupon.minOrderPaise) {
    return { ok: false, code: 'coupon_min_order' };
  }
  if (coupon.maxRedemptions != null && coupon.redeemedCount >= coupon.maxRedemptions) {
    return { ok: false, code: 'coupon_max_redeemed' };
  }
  return { ok: true };
}
