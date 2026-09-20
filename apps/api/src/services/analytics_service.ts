import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * Tenant analytics — the partner dashboard's Overview tiles and 7-day chart.
 *
 * MONEY IS WHAT WAS ACTUALLY TAKEN, on the day it was taken. Two sources, in
 * one ledger:
 *
 *   1. Payments circls processed — captured charges, less refunds. A refund is
 *      its own dated row carrying a negative amount, so refunding today does
 *      not erase the day the sale happened: yesterday keeps its bar and today
 *      takes the hit. Failed and still-pending charges are not money.
 *   2. Bookings the partner took at the desk (`payment_method = 'external'`).
 *      circls never saw that money so there is no payment row, but the booking
 *      records what was charged, and to the partner it is revenue like any
 *      other. Cancelling one removes it: circls has no refund to record, so the
 *      booking standing or not is the only signal there is.
 *
 * This replaces a slot-only, session-dated, list-price measure that could not
 * agree with the Activity feed (see PR #197): it ignored events and memberships
 * entirely — an events-only organiser saw a permanent zero — dated revenue by
 * when the court was booked FOR rather than when it was paid, priced at the
 * schedule's list price rather than what was charged, and dropped a booking
 * from history the moment it was cancelled.
 *
 * Counts follow the same rule: `bookingsToday` is everything booked today —
 * courts, events and memberships — which is what the Activity feed lists.
 *
 * OCCUPANCY REMAINS SLOT-BASED and session-dated, because that is what it
 * measures: how much of the bookable court time was taken. Events and
 * memberships have no slots to occupy.
 *
 * Money is aggregated PER CURRENCY, read off each payment (or desk booking)
 * rather than guessed from the venue's country: a tenant selling in both India
 * and the USA gets separate INR and USD buckets rather than a meaningless
 * paise+cents sum. Counts (bookings, occupancy) stay global.
 *
 * Windows are computed in IST inside Postgres so they never drift with the
 * server's wall-clock zone:
 *   today          = (now() AT TIME ZONE 'Asia/Kolkata')::date
 *   7-day window   = [today - 6 days, today]  (7 calendar days, inclusive)
 * Per-venue timezones remain a known limitation: a US venue's "today" is still
 * cut on IST midnight.
 *
 * Raw `db.execute` is used (mirroring slot_service.listSlots) so the IST-date
 * cast happens in SQL; bigint minor units and counts are quantized to JS
 * numbers with Number(); dates are 'YYYY-MM-DD' strings.
 */

export interface MoneyByCurrency {
  /** ISO 4217, e.g. 'INR' | 'USD'. */
  currency: string;
  /** Minor units (paise / cents) of `currency`. Can be negative on a day whose
   *  refunds outweighed its sales. */
  amountMinor: number;
}

export interface AnalyticsTrendPoint {
  date: string; // 'YYYY-MM-DD' (IST)
  bookings: number; // bookings made that IST day, in this currency
  revenuePaise: number; // net money taken that IST day, in the series' currency minor units
}

/** A full 7-day trend for one currency (a tenant usually has exactly one). */
export interface AnalyticsTrendSeries {
  currency: string;
  days: AnalyticsTrendPoint[]; // exactly 7, oldest→newest incl. today
}

export interface Analytics {
  /** Bookings made today — courts, events and memberships. */
  bookingsToday: number;
  /** One entry per currency with money taken today; [] when none. */
  revenueToday: MoneyByCurrency[];
  /** One entry per currency with money taken in the 7-day window; [] when none. */
  revenue7d: MoneyByCurrency[];
  /** Share of bookable court time taken over the window. Slots only. */
  occupancy7dPct: number;
  /** One series per currency with money taken in the window; [] when none. */
  trend7d: AnalyticsTrendSeries[];
}

/** The IST calendar day a timestamp falls on. */
const istDay = (col: ReturnType<typeof sql>) => sql`(${col} AT TIME ZONE 'Asia/Kolkata')::date`;

/** "Today" in IST, decided by Postgres rather than by the API's wall clock. */
const TODAY = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/**
 * An instant safely before the window starts, as a plain timestamptz.
 *
 * The window itself is expressed on the IST *date* of each row, which no index
 * can serve — without this the scans would read a tenant's entire history on
 * every dashboard load and grow forever. This bound is on the raw column, so
 * (tenant_id, created_at) can seek straight to the week. A day of slack either
 * side of the IST offset keeps it a pure optimisation: the date predicate
 * still decides what is in the window.
 */
const WINDOW_FLOOR = sql`
  (((now() AT TIME ZONE 'Asia/Kolkata')::date - 8) AT TIME ZONE 'Asia/Kolkata')`;

/**
 * A booking that stands. `cancelled` fell through and `pending` has not
 * happened yet — an abandoned checkout is not a sale, and counting one would
 * put a booking on the dashboard that no money will ever follow.
 */
const BOOKING_STANDS = sql`b.status in ('confirmed', 'completed', 'no_show')`;

/**
 * Every movement of money for a tenant, one row per movement: the IST day it
 * happened, its currency, and a signed minor-unit amount. Summing it gives
 * what the partner actually took.
 */
function moneyLedger(tenantId: string) {
  return sql`
    select ${istDay(sql`p.created_at`)} as d,
           p.currency                   as currency,
           p.amount_paise               as amount
      from payments p
     where p.tenant_id = ${tenantId}
       and p.created_at >= ${WINDOW_FLOOR}
       and (
         -- A charge that reached the customer's account. 'refunded' and
         -- 'partially_refunded' charges stay: the money WAS taken, and the
         -- refund that followed is its own row below.
         (p.kind = 'charge' and p.status in ('captured', 'refunded', 'partially_refunded'))
         -- Refund rows carry a negative amount_paise already.
         or (p.kind = 'refund' and p.status <> 'failed')
       )
    union all
    select ${istDay(sql`b.created_at`)} as d,
           b.currency                   as currency,
           b.total_paise                as amount
      from bookings b
     where b.tenant_id = ${tenantId}
       and b.created_at >= ${WINDOW_FLOOR}
       and b.payment_method = 'external'
       and ${BOOKING_STANDS}
       and b.total_paise is not null
  `;
}

/**
 * One row per sale, dated and in its currency — courts, events and
 * memberships alike, which is what the Activity feed lists. The tile answers
 * "what did I sell", so only bookings that stand are counted.
 *
 * Nearly all of it is the `bookings` ledger. The exception is a free,
 * coupon-less membership purchase: memberships_service skips the synthetic
 * booking for those, so they exist only as `user_memberships` rows. The feed
 * unions them in for exactly that reason, and so must this, or a plan with a
 * free tier would list its sign-ups on the Activity page and never move the
 * dashboard's count.
 *
 * The union mirrors the feed's shape, including its inner join on `users`: a
 * member the partner added by hand has no account behind them and appears on
 * neither. It parts from the feed on one point — a cancelled membership is
 * left out, as a cancelled booking is.
 */
function salesLedger(tenantId: string) {
  return sql`
    select ${istDay(sql`b.created_at`)} as d,
           b.currency                   as currency
      from bookings b
     where b.tenant_id = ${tenantId}
       and b.created_at >= ${WINDOW_FLOOR}
       and ${BOOKING_STANDS}
    union all
    select ${istDay(sql`um.created_at`)} as d,
           -- These carry no money and so no currency of their own. The
           -- tenant's country decides which series they are counted under,
           -- the same mapping lib/gateway.ts uses.
           case when upper(btrim(coalesce(t.country, '')))
                     in ('USA', 'US', 'UNITED STATES', 'UNITED STATES OF AMERICA')
                then 'USD' else 'INR' end as currency
      from user_memberships um
      join memberships m on m.id = um.membership_id
      join tenants t     on t.id = m.tenant_id
      join users u       on u.id = um.user_id
     where m.tenant_id = ${tenantId}
       and um.created_at >= ${WINDOW_FLOOR}
       and um.status <> 'cancelled'
       and not exists (
         select 1 from bookings b2
          where b2.tenant_id = ${tenantId}
            and b2.item_type = 'membership'
            and b2.item_data->>'userMembershipId' = um.id::text
       )
  `;
}

export async function getAnalytics(tenantId: string): Promise<Analytics> {
  // ---- Counts: bookingsToday (all item types) / occupancy7dPct (slots only).
  const scalarRows = await db.execute<Record<string, unknown>>(sql`
    select
      (select count(*) from (${salesLedger(tenantId)}) sales
        where sales.d = ${TODAY})                                                         as bookings_today,
      (select round(
         100.0 * count(*) filter (where s.status = 'booked')
         / nullif(count(*) filter (where s.status in ('open', 'held', 'booked')), 0)
       , 1)
         from slots s
        where s.tenant_id = ${tenantId}
          and s.deleted_at is null
          and ${istDay(sql`lower(s.time_range)`)} between ${TODAY} - 6 and ${TODAY})       as occupancy_7d_pct
  `);
  const scalar = (scalarRows as unknown as Record<string, unknown>[])[0] ?? {};

  // ---- Money per currency (today + 7-day window in one grouped pass).
  const revenueRows = await db.execute<Record<string, unknown>>(sql`
    with money as (${moneyLedger(tenantId)})
    select currency,
           coalesce(sum(amount) filter (where d = ${TODAY}), 0)                            as revenue_today,
           coalesce(sum(amount), 0)                                                        as revenue_7d
      from money
     where d between ${TODAY} - 6 and ${TODAY}
     group by 1
     order by 1
  `);
  const revenueToday: MoneyByCurrency[] = [];
  const revenue7d: MoneyByCurrency[] = [];
  for (const row of revenueRows as unknown as Record<string, unknown>[]) {
    const currency = row['currency'] as string;
    const todayMinor = Number(row['revenue_today']);
    const windowMinor = Number(row['revenue_7d']);
    // A zero bucket says nothing; a negative one — a day of refunds — does.
    if (todayMinor !== 0) revenueToday.push({ currency, amountMinor: todayMinor });
    if (windowMinor !== 0) revenue7d.push({ currency, amountMinor: windowMinor });
  }

  // ---- trend7d: per currency with activity, exactly 7 rows oldest→newest.
  // days × active-currencies CROSS JOIN, so quiet days surface as 0 within
  // each currency's series. A currency counts as active if it saw either money
  // or a booking — a day of free registrations is still a day of bookings.
  const trendRows = await db.execute<Record<string, unknown>>(sql`
    with days as (
      select generate_series(${TODAY} - 6, ${TODAY}, interval '1 day')::date as d
    ),
    money as (${moneyLedger(tenantId)}),
    mday as (
      select d, currency, sum(amount) as amount
        from money
       where d between ${TODAY} - 6 and ${TODAY}
       group by 1, 2
    ),
    bday as (
      select d, currency, count(*) as n
        from (${salesLedger(tenantId)}) sales
       where d between ${TODAY} - 6 and ${TODAY}
       group by 1, 2
    ),
    curs as (
      select currency from mday
      union
      select currency from bday
    )
    select curs.currency                          as currency,
           to_char(days.d, 'YYYY-MM-DD')          as date,
           coalesce(bday.n, 0)                    as bookings,
           coalesce(mday.amount, 0)               as revenue_paise
      from days cross join curs
      left join mday on mday.d = days.d and mday.currency = curs.currency
      left join bday on bday.d = days.d and bday.currency = curs.currency
     order by curs.currency, days.d
  `);

  const seriesByCurrency = new Map<string, AnalyticsTrendPoint[]>();
  for (const row of trendRows as unknown as Record<string, unknown>[]) {
    const currency = row['currency'] as string;
    const days = seriesByCurrency.get(currency) ?? [];
    days.push({
      date: row['date'] as string,
      bookings: Number(row['bookings']),
      revenuePaise: Number(row['revenue_paise']),
    });
    seriesByCurrency.set(currency, days);
  }
  const trend7d: AnalyticsTrendSeries[] = [...seriesByCurrency.entries()].map(
    ([currency, days]) => ({ currency, days }),
  );

  return {
    bookingsToday: Number(scalar['bookings_today'] ?? 0),
    revenueToday,
    revenue7d,
    // occupancy is null only when there are no bookable slots → 0 per contract.
    occupancy7dPct: Number(scalar['occupancy_7d_pct'] ?? 0),
    trend7d,
  };
}
