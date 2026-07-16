import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * Tenant analytics — all metrics are SLOT-based and tenant-scoped
 * (slots.tenant_id = tenantId, deleted_at is null), bucketed/filtered by each
 * slot's IST *session date*: `(lower(time_range) AT TIME ZONE 'Asia/Kolkata')::date`.
 *
 * Windows are computed in IST inside Postgres so they never drift with the
 * server's wall-clock zone:
 *   today          = (now() AT TIME ZONE 'Asia/Kolkata')::date
 *   7-day window   = [today - 6 days, today]  (7 calendar days, inclusive)
 *
 * Money is aggregated PER CURRENCY (derived from each slot's venue country,
 * mirroring lib/gateway.ts currencyForCountry): a tenant with venues in both
 * India and the USA gets separate INR and USD buckets rather than a
 * meaningless paise+cents sum. Counts (bookings, occupancy) stay global.
 *
 * Raw `db.execute` is used (mirroring slot_service.listSlots) so the IST-date
 * cast happens in SQL; bigint minor units and counts are quantized to JS
 * numbers with Number(); dates are 'YYYY-MM-DD' strings.
 */

export interface MoneyByCurrency {
  /** ISO 4217, e.g. 'INR' | 'USD'. */
  currency: string;
  /** Minor units (paise / cents) of `currency`. */
  amountMinor: number;
}

export interface AnalyticsTrendPoint {
  date: string; // 'YYYY-MM-DD' (IST session date)
  bookings: number; // distinct booked booking_id that IST day (this currency's venues)
  revenuePaise: number; // Σ booked price that IST day, in the series' currency minor units
}

/** A full 7-day trend for one currency (a tenant usually has exactly one). */
export interface AnalyticsTrendSeries {
  currency: string;
  days: AnalyticsTrendPoint[]; // exactly 7, oldest→newest incl. today
}

export interface Analytics {
  bookingsToday: number;
  /** One entry per currency with revenue today; [] when none. */
  revenueToday: MoneyByCurrency[];
  /** One entry per currency with revenue in the 7-day window; [] when none. */
  revenue7d: MoneyByCurrency[];
  occupancy7dPct: number;
  /** One series per currency with booked revenue in the window; [] when none. */
  trend7d: AnalyticsTrendSeries[];
}

/**
 * The slot's settlement currency, from its venue's country. Must stay in sync
 * with lib/gateway.ts `currencyForCountry` / `isUsCountry`.
 */
const slotCurrency = sql`
  case when upper(btrim(coalesce(v.country, '')))
         in ('USA', 'US', 'UNITED STATES', 'UNITED STATES OF AMERICA')
       then 'USD' else 'INR' end`;

export async function getAnalytics(tenantId: string): Promise<Analytics> {
  // The IST session date of a slot's start, reused throughout.
  const istDate = sql`(lower(s.time_range) AT TIME ZONE 'Asia/Kolkata')::date`;
  // "Today" and the inclusive 7-day window, computed in IST by Postgres.
  const today = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`;

  // ---- Counts: bookingsToday / occupancy7dPct (currency-agnostic).
  // FILTER restricts each aggregate to the rows it cares about; counts are 0
  // (not null) for empty sets except the occupancy denominator, guarded with
  // nullif.
  const scalarRows = await db.execute<Record<string, unknown>>(sql`
    select
      count(distinct s.booking_id)
        filter (where s.status = 'booked' and ${istDate} = ${today})                       as bookings_today,
      round(
        100.0 * count(*) filter (where s.status = 'booked'
                  and ${istDate} between ${today} - 6 and ${today})
        / nullif(count(*) filter (where s.status in ('open', 'held', 'booked')
                  and ${istDate} between ${today} - 6 and ${today}), 0)
      , 1)                                                                                   as occupancy_7d_pct
    from slots s
    where s.tenant_id = ${tenantId}
      and s.deleted_at is null
  `);
  const scalar = (scalarRows as unknown as Record<string, unknown>[])[0] ?? {};

  // ---- Revenue per currency (today + 7-day window in one grouped pass).
  const revenueRows = await db.execute<Record<string, unknown>>(sql`
    select
      ${slotCurrency}                                                                        as currency,
      coalesce(sum(s.price_paise) filter (where ${istDate} = ${today}), 0)                   as revenue_today,
      coalesce(sum(s.price_paise), 0)                                                        as revenue_7d
    from slots s
    join arenas a on a.id = s.arena_id
    join venues v on v.id = a.venue_id
    where s.tenant_id = ${tenantId}
      and s.deleted_at is null
      and s.status = 'booked'
      and ${istDate} between ${today} - 6 and ${today}
    group by 1
    order by 1
  `);
  const revenueToday: MoneyByCurrency[] = [];
  const revenue7d: MoneyByCurrency[] = [];
  for (const row of revenueRows as unknown as Record<string, unknown>[]) {
    const currency = row['currency'] as string;
    const todayMinor = Number(row['revenue_today']);
    if (todayMinor > 0) revenueToday.push({ currency, amountMinor: todayMinor });
    revenue7d.push({ currency, amountMinor: Number(row['revenue_7d']) });
  }

  // ---- trend7d: per currency with activity, exactly 7 rows oldest→newest.
  // days × active-currencies CROSS JOIN, so zero-activity days surface as 0
  // within each currency's series.
  const trendRows = await db.execute<Record<string, unknown>>(sql`
    with days as (
      select generate_series(${today} - 6, ${today}, interval '1 day')::date as d
    ),
    booked as (
      select ${istDate}                          as d,
             ${slotCurrency}                     as currency,
             s.booking_id                        as booking_id,
             s.price_paise                       as price_paise
      from slots s
      join arenas a on a.id = s.arena_id
      join venues v on v.id = a.venue_id
      where s.tenant_id = ${tenantId}
        and s.deleted_at is null
        and s.status = 'booked'
        and ${istDate} between ${today} - 6 and ${today}
    ),
    curs as (select distinct currency from booked),
    agg as (
      select d, currency,
             count(distinct booking_id)          as bookings,
             coalesce(sum(price_paise), 0)       as revenue_paise
      from booked
      group by d, currency
    )
    select curs.currency                          as currency,
           to_char(days.d, 'YYYY-MM-DD')          as date,
           coalesce(agg.bookings, 0)              as bookings,
           coalesce(agg.revenue_paise, 0)         as revenue_paise
    from days cross join curs
    left join agg on agg.d = days.d and agg.currency = curs.currency
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
