import { type SQL, sql } from 'drizzle-orm';

/**
 * When consumer bookings started recording who they are for (customer_user_id)
 * in production: 3 July 2026, with a day's margin for the deploy. Consumer
 * bookings made before then carry only their creator. A circls-channel booking
 * made since with no customer was taken by staff for someone else (e.g.
 * POST /v1/bookings with an online payment), so it is never the creator's own.
 */
export const CUSTOMERS_STAMPED_FROM = '2026-07-04T00:00:00Z';

/**
 * The bookings that are `userId`'s own, the one rule for "My bookings", its
 * detail page, the support intake and the support context panel: theirs as
 * the customer, or an old consumer booking they made before customers were
 * stamped. Walk-ins, door registrations and API or staff bookings belong to
 * their customers, not to whoever entered them.
 *
 * `alias` is the bookings table's name or alias in the query (a constant from
 * code, never input).
 */
export function ownBookingCondition(userId: string, alias = 'b'): SQL {
  const col = (name: string) => sql.raw(`${alias}.${name}`);
  return sql`(${col('customer_user_id')} = ${userId}::uuid
    or (${col('customer_user_id')} is null
        and ${col('created_by_user_id')} = ${userId}::uuid
        and ${col('channel')} = 'circls'
        and ${col('created_at')} < ${CUSTOMERS_STAMPED_FROM}::timestamptz))`;
}
