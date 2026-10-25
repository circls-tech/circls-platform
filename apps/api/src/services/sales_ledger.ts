import { sql, type SQL } from 'drizzle-orm';
import { bookingStandsSql, bookingUnitsSql } from './booking_units.js';
import { itemKeySql } from './item_key.js';

/**
 * The one definition of "what was sold, and when": every "Sales" count dated
 * by when the sale was made reads this ledger — the partner dashboard's Sales
 * today and its 7-day chart, the admin tenant list and partner-users report
 * (Sales, 30 days), the admin dashboard's Sales tiles and the Engagement
 * report. Earnings and the revenue tabs count from payments instead (see
 * revenue_service), because they put the count beside money that settled.
 *
 * One row per sale, with what it sold in {@link bookingUnitsSql} units:
 * tickets for an event, one per court booking or plan.
 *
 * Nearly all of it is the `bookings` ledger, bookings that stand only
 * ({@link bookingStandsSql}). The exception is a free, coupon-less membership
 * purchase: memberships_service skips the synthetic booking for those, so they
 * exist only as `user_memberships` rows. The Activity feed unions them in for
 * exactly that reason, and so must this, or a plan with a free tier would list
 * its sign-ups on the Activity page and never move a Sales count.
 *
 * The union mirrors the feed's shape, including its inner join on `users`: a
 * member the partner added by hand has no account behind them and appears on
 * neither. It parts from the feed on one point — a cancelled membership is
 * left out, as a cancelled booking is.
 *
 * Columns: tenant_id, created_at, currency, item_type ('slot' | 'event' |
 * 'membership'), item_id (the event, plan or venue, as {@link itemKeySql}
 * files it), channel (a booking's own; 'circls' for a plan a customer took,
 * 'walkin' for one a partner recorded) and units.
 *
 * Every alias is prefixed `sl_` so a caller can correlate on its own
 * aliases (`tenantId: sql\`t.id\``) without one being shadowed in here.
 *
 * @param opts.tenantId SQL for the one tenant to read; omitted, every tenant.
 * @param opts.since    SQL instant; only sales made at or after it.
 */
export function salesLedgerSql(opts: { tenantId?: SQL; since?: SQL } = {}): SQL {
  const bookingTenant = opts.tenantId ? sql`and sl_b.tenant_id = ${opts.tenantId}` : sql``;
  const planTenant = opts.tenantId ? sql`and sl_m.tenant_id = ${opts.tenantId}` : sql``;
  const bookingSince = opts.since ? sql`and sl_b.created_at >= ${opts.since}` : sql``;
  const planSince = opts.since ? sql`and sl_um.created_at >= ${opts.since}` : sql``;
  return sql`
    select sl_b.tenant_id                                          as tenant_id,
           sl_b.created_at                                         as created_at,
           sl_b.currency::text                                     as currency,
           sl_b.item_type::text                                    as item_type,
           ${itemKeySql('sl_b')}                                   as item_id,
           sl_b.channel::text                                      as channel,
           ${bookingUnitsSql(sql`sl_b.id`, sql`sl_b.item_type`)}   as units
      from bookings sl_b
     where ${bookingStandsSql('sl_b')}
       ${bookingTenant}
       ${bookingSince}
    union all
    select sl_m.tenant_id,
           sl_um.created_at,
           -- These carry no money and so no currency of their own. The
           -- tenant's country decides which series they are counted under,
           -- the same mapping lib/gateway.ts uses.
           case when upper(btrim(coalesce(sl_t.country, '')))
                     in ('USA', 'US', 'UNITED STATES', 'UNITED STATES OF AMERICA')
                then 'USD' else 'INR' end,
           'membership',
           sl_m.id,
           case when sl_um.created_by_user_id is null then 'circls' else 'walkin' end,
           1
      from user_memberships sl_um
      join memberships sl_m on sl_m.id = sl_um.membership_id
      join tenants sl_t     on sl_t.id = sl_m.tenant_id
      join users sl_u       on sl_u.id = sl_um.user_id
     where sl_um.status <> 'cancelled'
       ${planTenant}
       ${planSince}
       and not exists (
         select 1 from bookings sl_b2
          where sl_b2.tenant_id = sl_m.tenant_id
            and sl_b2.item_type = 'membership'
            and sl_b2.item_data->>'userMembershipId' = sl_um.id::text
       )
  `;
}

/** How many units the ledger holds for these options, as a scalar subquery
 *  (0 when nothing sold). Correlate it through `tenantId`. */
export function salesCountSql(opts: { tenantId?: SQL; since?: SQL }): SQL {
  return sql`(select coalesce(sum(sl.units), 0) from (${salesLedgerSql(opts)}) sl)`;
}
