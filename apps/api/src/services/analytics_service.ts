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
 * Raw `db.execute` is used (mirroring slot_service.listSlots) so the IST-date
 * cast happens in SQL; bigint paise and counts are quantized to JS numbers with
 * Number(); dates are 'YYYY-MM-DD' strings.
 */

export interface AnalyticsTrendPoint {
  date: string; // 'YYYY-MM-DD' (IST session date)
  bookings: number; // distinct booked booking_id that IST day
  revenuePaise: number; // Σ booked price_paise that IST day
}

export interface Analytics {
  bookingsToday: number;
  revenueTodayPaise: number;
  revenue7dPaise: number;
  occupancy7dPct: number;
  trend7d: AnalyticsTrendPoint[]; // exactly 7, oldest→newest incl. today
}

export async function getAnalytics(tenantId: string): Promise<Analytics> {
  // The IST session date of a slot's start, reused throughout.
  const istDate = sql`(lower(s.time_range) AT TIME ZONE 'Asia/Kolkata')::date`;
  // "Today" and the inclusive 7-day window, computed in IST by Postgres.
  const today = sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`;

  // ---- Scalars: bookingsToday / revenueTodayPaise / revenue7dPaise / occupancy7dPct
  // All in one pass over the tenant's live slots. FILTER restricts each
  // aggregate to the rows it cares about; counts/sums are 0 (not null) for
  // empty sets except the occupancy denominator which we guard with nullif.
  const scalarRows = await db.execute<Record<string, unknown>>(sql`
    select
      count(distinct s.booking_id)
        filter (where s.status = 'booked' and ${istDate} = ${today})                       as bookings_today,
      coalesce(sum(s.price_paise)
        filter (where s.status = 'booked' and ${istDate} = ${today}), 0)                    as revenue_today_paise,
      coalesce(sum(s.price_paise)
        filter (where s.status = 'booked'
                  and ${istDate} between ${today} - 6 and ${today}), 0)                     as revenue_7d_paise,
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

  // ---- trend7d: exactly 7 rows oldest→newest (today-6 … today).
  // generate_series produces every IST day in the window; the per-day booked
  // aggregates are LEFT JOINed so days with zero activity surface as 0.
  const trendRows = await db.execute<Record<string, unknown>>(sql`
    with days as (
      select generate_series(${today} - 6, ${today}, interval '1 day')::date as d
    ),
    agg as (
      select ${istDate}                          as d,
             count(distinct s.booking_id)         as bookings,
             coalesce(sum(s.price_paise), 0)      as revenue_paise
      from slots s
      where s.tenant_id = ${tenantId}
        and s.deleted_at is null
        and s.status = 'booked'
        and ${istDate} between ${today} - 6 and ${today}
      group by ${istDate}
    )
    select to_char(days.d, 'YYYY-MM-DD')          as date,
           coalesce(agg.bookings, 0)              as bookings,
           coalesce(agg.revenue_paise, 0)         as revenue_paise
    from days
    left join agg on agg.d = days.d
    order by days.d
  `);

  const trend7d: AnalyticsTrendPoint[] = (trendRows as unknown as Record<string, unknown>[]).map(
    (row) => ({
      date: row['date'] as string,
      bookings: Number(row['bookings']),
      revenuePaise: Number(row['revenue_paise']),
    }),
  );

  return {
    bookingsToday: Number(scalar['bookings_today'] ?? 0),
    revenueTodayPaise: Number(scalar['revenue_today_paise'] ?? 0),
    revenue7dPaise: Number(scalar['revenue_7d_paise'] ?? 0),
    // occupancy is null only when there are no bookable slots → 0 per contract.
    occupancy7dPct: Number(scalar['occupancy_7d_pct'] ?? 0),
    trend7d,
  };
}
