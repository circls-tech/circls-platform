import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

/**
 * Coupon funding stats — aggregates over `coupon_redemptions`, the append-only
 * record of who absorbed each discount (`funder`: 'org' = the tenant whose
 * item was sold, 'platform' = Circls).
 *
 * Tenant queries filter by `tenant_id` and are served by the
 * (tenant_id, funder, created_at) index; admin queries scan the whole table
 * (low volume). Mirrors analytics_service conventions: raw `db.execute` so
 * date math happens in SQL, bigint minor units quantized with Number(),
 * monthly buckets computed in IST.
 *
 * Amounts are minor units (paise) with no currency dimension —
 * coupon_redemptions doesn't record currency, so callers apply the same
 * convention as the coupon UIs (per-coupon currency from the coupon's scope).
 */

export interface CouponFunderTotals {
  redemptions: number;
  discountPaise: number;
  basePaise: number;
}

export interface CouponStatRow {
  couponId: string;
  code: string;
  redemptions: number;
  discountPaise: number;
  basePaise: number;
}

export interface TenantCouponStats {
  /** Discounts this tenant funded with its own coupons. */
  orgFunded: CouponFunderTotals;
  /** Circls-funded discounts applied to this tenant's sales (payout-neutral). */
  platformFunded: CouponFunderTotals;
  /** Per-coupon breakdown of the tenant's own (org-funded) coupons. */
  byCoupon: CouponStatRow[];
}

export interface CouponMonthlyPoint {
  month: string; // 'YYYY-MM' (IST)
  redemptions: number;
  discountPaise: number;
}

export interface AdminCouponStats {
  /** Circls discount spend across all tenants. */
  platformFunded: CouponFunderTotals;
  /** Partner-funded discounts across all tenants. */
  orgFunded: CouponFunderTotals;
  /** Per-coupon breakdown of platform (Circls-funded) coupons. */
  byCoupon: CouponStatRow[];
  /** Circls-funded spend per IST month, oldest→newest. */
  monthly: CouponMonthlyPoint[];
}

export interface CouponStatsRange {
  from?: Date;
  to?: Date;
}

const ZERO_TOTALS: CouponFunderTotals = { redemptions: 0, discountPaise: 0, basePaise: 0 };

/** `and r.created_at >= from and r.created_at < to` for whichever bounds exist.
 *  Dates go over the wire as ISO strings — the raw-execute driver path can't
 *  serialize Date params. */
function rangeFilter(range?: CouponStatsRange) {
  const parts = [sql`true`];
  if (range?.from) parts.push(sql`r.created_at >= ${range.from.toISOString()}::timestamptz`);
  if (range?.to) parts.push(sql`r.created_at < ${range.to.toISOString()}::timestamptz`);
  return sql.join(parts, sql` and `);
}

function readTotals(rows: Record<string, unknown>[]): {
  orgFunded: CouponFunderTotals;
  platformFunded: CouponFunderTotals;
} {
  let orgFunded = ZERO_TOTALS;
  let platformFunded = ZERO_TOTALS;
  for (const row of rows) {
    const totals: CouponFunderTotals = {
      redemptions: Number(row['redemptions']),
      discountPaise: Number(row['discount_paise']),
      basePaise: Number(row['base_paise']),
    };
    if (row['funder'] === 'platform') platformFunded = totals;
    else orgFunded = totals;
  }
  return { orgFunded, platformFunded };
}

function readByCoupon(rows: Record<string, unknown>[]): CouponStatRow[] {
  return rows.map((row) => ({
    couponId: row['coupon_id'] as string,
    code: row['code'] as string,
    redemptions: Number(row['redemptions']),
    discountPaise: Number(row['discount_paise']),
    basePaise: Number(row['base_paise']),
  }));
}

export async function getTenantCouponStats(
  tenantId: string,
  range?: CouponStatsRange,
): Promise<TenantCouponStats> {
  const inRange = rangeFilter(range);

  const totalRows = await db.execute<Record<string, unknown>>(sql`
    select r.funder                              as funder,
           count(*)::int                         as redemptions,
           coalesce(sum(r.discount_paise), 0)    as discount_paise,
           coalesce(sum(r.base_paise), 0)        as base_paise
    from coupon_redemptions r
    where r.tenant_id = ${tenantId} and ${inRange}
    group by r.funder
  `);

  // Org-funded rows for this tenant reference this tenant's own coupons by
  // construction (funder='org' ⇔ coupon.owner_type='tenant' for the same org).
  const byCouponRows = await db.execute<Record<string, unknown>>(sql`
    select r.coupon_id                           as coupon_id,
           c.code                                as code,
           count(*)::int                         as redemptions,
           coalesce(sum(r.discount_paise), 0)    as discount_paise,
           coalesce(sum(r.base_paise), 0)        as base_paise
    from coupon_redemptions r
    join coupons c on c.id = r.coupon_id
    where r.tenant_id = ${tenantId} and r.funder = 'org' and ${inRange}
    group by r.coupon_id, c.code
    order by coalesce(sum(r.discount_paise), 0) desc, c.code
  `);

  return {
    ...readTotals(totalRows as unknown as Record<string, unknown>[]),
    byCoupon: readByCoupon(byCouponRows as unknown as Record<string, unknown>[]),
  };
}

export async function getAdminCouponStats(range?: CouponStatsRange): Promise<AdminCouponStats> {
  const inRange = rangeFilter(range);

  const totalRows = await db.execute<Record<string, unknown>>(sql`
    select r.funder                              as funder,
           count(*)::int                         as redemptions,
           coalesce(sum(r.discount_paise), 0)    as discount_paise,
           coalesce(sum(r.base_paise), 0)        as base_paise
    from coupon_redemptions r
    where ${inRange}
    group by r.funder
  `);

  const byCouponRows = await db.execute<Record<string, unknown>>(sql`
    select r.coupon_id                           as coupon_id,
           c.code                                as code,
           count(*)::int                         as redemptions,
           coalesce(sum(r.discount_paise), 0)    as discount_paise,
           coalesce(sum(r.base_paise), 0)        as base_paise
    from coupon_redemptions r
    join coupons c on c.id = r.coupon_id
    where r.funder = 'platform' and ${inRange}
    group by r.coupon_id, c.code
    order by coalesce(sum(r.discount_paise), 0) desc, c.code
  `);

  const monthlyRows = await db.execute<Record<string, unknown>>(sql`
    select to_char(date_trunc('month', r.created_at at time zone 'Asia/Kolkata'), 'YYYY-MM')
                                                 as month,
           count(*)::int                         as redemptions,
           coalesce(sum(r.discount_paise), 0)    as discount_paise
    from coupon_redemptions r
    where r.funder = 'platform' and ${inRange}
    group by 1
    order by 1
  `);

  return {
    ...readTotals(totalRows as unknown as Record<string, unknown>[]),
    byCoupon: readByCoupon(byCouponRows as unknown as Record<string, unknown>[]),
    monthly: (monthlyRows as unknown as Record<string, unknown>[]).map((row) => ({
      month: row['month'] as string,
      redemptions: Number(row['redemptions']),
      discountPaise: Number(row['discount_paise']),
    })),
  };
}
