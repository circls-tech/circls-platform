/**
 * Most court slots one checkout may hold. Mirrors the API's
 * `MAX_SLOTS_PER_BOOKING` (apps/api/src/lib/booking_limits.ts): the cart
 * stops at the same number so a bigger cart can't fail late at checkout.
 */
export const MAX_CART_SLOTS = 20;
