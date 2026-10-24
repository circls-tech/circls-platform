/**
 * Commission-free period — every org was promised its first
 * {@link COMMISSION_WAIVER_MONTHS} months without partner commission, counted
 * from its first paid booking.
 *
 * RECORD-ONLY. Nothing here changes what a sale is charged: the charge paths
 * still snapshot tenants.commission_bps and any per-event override
 * (billing_config.ts), so admins keep both at 0% until the period ends and
 * raise them by hand. This module only works out the dates, for the admin
 * console and the partner's Earnings page.
 *
 * Both dates are admin overrides on the tenant row; NULL means the default:
 *   - start: the day of the org's first paid booking, in the org's zone
 *   - end:   start + 3 months — the day commission starts
 * Deriving rather than stamping the start keeps the charge paths untouched and
 * needs no backfill. It can move once: if the first sale is later refunded in
 * full, the next one becomes the start — admins pin a start to stop that.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dateStrInTz } from '../lib/calendar_day.js';
import { NotFound } from '../lib/errors.js';

export const COMMISSION_WAIVER_MONTHS = 3;

export type CommissionWaiverStatus = 'not_started' | 'active' | 'ended';

export interface CommissionWaiver {
  /** not_started: no start yet (no paid booking) or a start in the future;
   *  active: commission-free today; ended: on or after the end date. */
  status: CommissionWaiverStatus;
  /** First commission-free day (YYYY-MM-DD); null until the first paid booking. */
  startsOn: string | null;
  /** The day the period ends and commission starts (YYYY-MM-DD); null until
   *  there is a start or an admin-set end. */
  endsOn: string | null;
  /** Day of the org's first paid booking, in the org's zone; null if none. */
  firstPaidOn: string | null;
  startSetByAdmin: boolean;
  endSetByAdmin: boolean;
  /** Partner commission agreed for after the period, in bps. Null = not decided. */
  afterWaiverBps: number | null;
  /** Today in the org's zone — the day `status` was judged on — so a client
   *  can count days or preview edited dates without guessing the zone. */
  today: string;
  /** The default length, so clients never hard-code it. */
  months: number;
}

export interface CommissionWaiverInput {
  /** tenants.commission_waiver_starts_on — the admin override. */
  startsOn: string | null;
  /** tenants.commission_waiver_ends_on — the admin override. */
  endsOn: string | null;
  afterWaiverBps: number | null;
  /** When the org's first paid booking was paid. */
  firstPaidAt: Date | null;
  /** IANA zone the org's days are cut in. */
  tz: string;
}

const FALLBACK_TZ = 'Asia/Kolkata';

/** The calendar day `at` falls on in `tz`, as YYYY-MM-DD. */
export function dayIn(tz: string, at: Date): string {
  try {
    return dateStrInTz(at, tz);
  } catch {
    // A malformed tz_name must not take the page down.
    return dateStrInTz(at, FALLBACK_TZ);
  }
}

/** YYYY-MM-DD plus `months`, clamped to the month's last day (31 Oct + 3 =
 *  31 Jan; 30 Nov + 3 = 28 Feb), the same as Postgres `date + interval`. */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(Math.min(d, lastDay))}`;
}

export function resolveCommissionWaiver(
  input: CommissionWaiverInput,
  now: Date = new Date(),
): CommissionWaiver {
  const firstPaidOn = input.firstPaidAt ? dayIn(input.tz, input.firstPaidAt) : null;
  const startsOn = input.startsOn ?? firstPaidOn;
  const endsOn =
    input.endsOn ?? (startsOn ? addMonths(startsOn, COMMISSION_WAIVER_MONTHS) : null);
  // YYYY-MM-DD strings compare correctly as strings.
  const today = dayIn(input.tz, now);
  const status: CommissionWaiverStatus =
    endsOn !== null && today >= endsOn
      ? 'ended'
      : startsOn === null || today < startsOn
        ? 'not_started'
        : 'active';
  return {
    status,
    startsOn,
    endsOn,
    firstPaidOn,
    startSetByAdmin: input.startsOn !== null,
    endSetByAdmin: input.endsOn !== null,
    afterWaiverBps: input.afterWaiverBps,
    today,
    months: COMMISSION_WAIVER_MONTHS,
  };
}

/**
 * The org's zone, as SQL: its first venue's tz_name, else its first event's
 * (an events-only organiser has no venue), else IST.
 */
export function orgTzSql(tenantId: SQL): SQL {
  return sql`coalesce(
    (select v.tz_name from venues v where v.tenant_id = ${tenantId}
      order by v.created_at, v.id limit 1),
    (select e.tz_name from events e where e.tenant_id = ${tenantId} and e.tz_name is not null
      order by e.created_at, e.id limit 1),
    ${FALLBACK_TZ})`;
}

/**
 * When the org's first paid booking was paid, as SQL: its earliest charge that
 * settles through Circls and wasn't refunded in full. A settlement hold is
 * stamped only on a captured charge whose booking still stands
 * (settlement_hold_service), which leaves out failed and abandoned checkouts
 * and desk bookings paid to the venue; dropping full refunds leaves out a
 * partner's own test purchase. Dated by payments.created_at, as Earnings dates
 * a sale.
 */
export function firstPaidAtSql(tenantId: SQL): SQL {
  return sql`(select min(p.created_at) from payments p
    where p.tenant_id = ${tenantId}
      and p.kind = 'charge'
      and p.amount_paise > 0
      and p.status <> 'refunded'
      and p.settlement_hold_until is not null)`;
}

/** Map one row carrying the three tenant columns + first_paid_at + tz. */
export function waiverFromRow(r: Record<string, unknown>, now?: Date): CommissionWaiver {
  const afterBps = r['commission_after_waiver_bps'];
  return resolveCommissionWaiver(
    {
      startsOn: (r['commission_waiver_starts_on'] as string | null) ?? null,
      endsOn: (r['commission_waiver_ends_on'] as string | null) ?? null,
      afterWaiverBps: afterBps == null ? null : Number(afterBps),
      ...basisFromRow(r),
    },
    now,
  );
}

function basisFromRow(r: Record<string, unknown>): { firstPaidAt: Date | null; tz: string } {
  const firstPaid = r['first_paid_at'];
  return {
    firstPaidAt: firstPaid ? new Date(firstPaid as string | Date) : null,
    tz: (r['tz'] as string | null) ?? FALLBACK_TZ,
  };
}

/**
 * The select-list fragment {@link waiverFromRow} reads, for a query over
 * `tenants t`. Dates are cast to text so the driver hands back YYYY-MM-DD
 * strings, never a midnight-UTC Date.
 */
export function waiverColumnsSql(): SQL {
  return sql`
    t.commission_waiver_starts_on::text AS commission_waiver_starts_on,
    t.commission_waiver_ends_on::text   AS commission_waiver_ends_on,
    t.commission_after_waiver_bps       AS commission_after_waiver_bps,
    ${firstPaidAtSql(sql`t.id`)}        AS first_paid_at,
    ${orgTzSql(sql`t.id`)}              AS tz`;
}

/** `db` or a tx — anything that can run a raw statement. */
type WaiverExec = Pick<typeof db, 'execute'>;

/** The derived inputs alone — first paid booking and zone — for a caller that
 *  already holds the tenant row. */
export async function waiverBasis(
  tenantId: string,
  exec: WaiverExec = db,
): Promise<{ firstPaidAt: Date | null; tz: string }> {
  const rows = (await exec.execute<Record<string, unknown>>(sql`
    SELECT ${firstPaidAtSql(sql`${tenantId}::uuid`)} AS first_paid_at,
           ${orgTzSql(sql`${tenantId}::uuid`)}       AS tz
  `)) as unknown as Record<string, unknown>[];
  return basisFromRow(rows[0] ?? {});
}

export async function getCommissionWaiver(tenantId: string): Promise<CommissionWaiver> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    SELECT ${waiverColumnsSql()}
    FROM tenants t
    WHERE t.id = ${tenantId}
  `)) as unknown as Record<string, unknown>[];
  const row = rows[0];
  if (!row) throw new NotFound('Tenant not found', 'tenant_not_found');
  return waiverFromRow(row);
}

/**
 * How many of the org's events that can still sell override partner
 * commission above 0%. The override wins over the tenant rate
 * (billing_config.resolveBillingConfig), so during the period each one is
 * charging commission the partner was promised they wouldn't pay.
 */
export async function countEventsChargingCommission(tenantId: string): Promise<number> {
  const rows = (await db.execute<Record<string, unknown>>(sql`
    SELECT count(*)::int AS n FROM events
    WHERE tenant_id = ${tenantId}::uuid
      AND partner_commission_bps > 0
      AND status IN ('draft', 'pending_review', 'published')
      AND archived_at IS NULL
      AND (ends_at IS NULL OR ends_at > now())
  `)) as unknown as Record<string, unknown>[];
  return Number(rows[0]?.['n'] ?? 0);
}
