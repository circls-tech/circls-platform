import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { creditableCharge, settleableCharge } from './settlement_credit.js';

/**
 * Revenue read models for the admin console.
 *
 * These answer a question payouts cannot answer yet: "how much has this
 * organisation sold, as of right now?" A payout only exists once its week has
 * been reconciled, so until then an admin asked that question had nothing to
 * look at. These figures lead the payout rather than mirroring it.
 *
 * WHAT THE TWO NUMBERS MEAN
 *
 *   gross — what customers actually paid, less what was refunded. The same
 *           money the partner dashboard calls "Revenue", so the two agree.
 *           Every payment counts, settling or not: the customer really paid.
 *   net   — what the partner is owed once Circls' commission comes out: the
 *           settleable base less partner commission, over the money that will
 *           actually settle. This is the money that later shows up in a payout.
 *
 * The gap between them is Circls' commission plus the gateway gross-up, which
 * is why `commissionPaise` is returned alongside rather than left implicit.
 *
 * The two measures count different row sets ON PURPOSE, which is why
 * `moneyRows` MARKS each row with `payout_basis` rather than filtering: gross
 * has to keep agreeing with the partner dashboard, and net has to keep agreeing
 * with the payout. Filtering would have forced one of those to break.
 *
 * NOT a deliberate difference, and now fixed: net used to count every charge
 * and deduct every refund. A payment that succeeds after its booking was
 * already cancelled is auto-refunded and never settles — charge and refund
 * cancel out, but the commission snapshotted on that charge did not, so net
 * came out short by Circls' cut of a sale that never happened. An admin
 * reading it would think a partner had been over-paid when they had not.
 *
 * DELIBERATE CHOICES, each of which makes these differ from a payout:
 *
 *   - Dated by `payments.created_at`, when the money moved — not by
 *     `settlement_released_at`, which is when a payout would pick it up. A
 *     sale made today appears here today and in a payout next week. That lead
 *     is the entire point.
 *   - Commission is NOT reversed on a refund, matching payout reconciliation:
 *     `partner_commission_paise` is snapshotted at charge time and never
 *     written back. So a fully refunded sale leaves its commission behind in
 *     both places.
 *   - Desk bookings (`payment_method = 'external'`) are excluded. Circls never
 *     handled that money and it will never reach a payout. Note this is why an
 *     admin's figure for a tenant can sit below the partner's own dashboard,
 *     which counts desk takings because the partner did take them.
 *
 * Legacy rows are handled the way payout_service handles them: a NULL
 * `settle_base_paise` falls back to `amount_paise`, and a NULL
 * `partner_commission_paise` is recomputed from the tenant's current rate.
 */

/** One row of money: a slice of sales in a single currency. */
export interface RevenueSlice {
  /** 'slot' | 'event' | 'membership' — what was sold. */
  itemType: string;
  /** ISO 4217. Slices are never summed across currencies. */
  currency: string;
  /** Customer money taken, less refunds, in minor units. */
  grossPaise: number;
  /** Payable to the partner after commission, in minor units. */
  netPaise: number;
  /** Circls' partner-side commission, in minor units. */
  commissionPaise: number;
  /** Refunded customer money in the window, as a positive number. */
  refundsPaise: number;
  /**
   * Distinct bookings that made a sale in the window — charges that will
   * settle to the partner, the same set `net` is computed over.
   *
   * A payment that succeeded after its booking was already cancelled is not a
   * sale: it is auto-refunded and never settles. Its money still shows in
   * `gross` (taken and given back, netting to nothing) because the customer
   * really was charged, but counting it here would report sales a tenant
   * never made, and leave a positive count sitting beside a `net` of zero
   * with nothing to explain the gap.
   */
  bookings: number;
}

/** How {@link moneyRows} should be narrowed. */
export interface MoneyRowsOptions {
  /** Narrow to one tenant; omitted, it is the whole platform. */
  tenantId?: string | undefined;
}

/**
 * Every payment that moved money, with what it was for and what it is worth
 * under each of the two measures. One row per payment; callers group it.
 *
 * Exported so the partner-facing earnings figures work from the SAME base and
 * commission expressions as the admin console, rather than a second copy that
 * can drift.
 */
export function moneyRows(from: string, to: string, opts: MoneyRowsOptions = {}): SQL {
  const { tenantId } = opts;
  const tenantClause = tenantId ? sql`and p.tenant_id = ${tenantId}::uuid` : sql``;
  return sql`
    select b.item_type::text                                     as item_type,
           b.venue_id                                            as venue_id,
           b.item_data                                           as item_data,
           p.currency                                            as currency,
           p.booking_id                                          as booking_id,
           p.kind::text                                          as kind,
           -- Customer cash. Refund rows already carry a negative amount.
           p.amount_paise                                        as gross,
           -- The settleable base a payout works from, negated on refunds by
           -- refund_service, so charges and refunds sum directly.
           coalesce(p.settle_base_paise, p.amount_paise)          as base,
           -- Snapshotted at charge time; never reversed by a refund.
           case when p.kind = 'charge'
                then coalesce(p.partner_commission_paise,
                              (coalesce(p.settle_base_paise, p.amount_paise)
                               * t.commission_bps) / 10000)
                else 0 end                                       as commission,
           -- Money that will actually reach the partner: a charge needs a
           -- settlement hold or release, a refund needs its charge to have had
           -- one. Both halves move together (settlement_credit). MARKED, not
           -- filtered, so gross can still count every payment made.
           case when p.kind = 'charge' then ${settleableCharge('p')}
                else ${creditableCharge('p')} end                 as payout_basis
      from payments p
      join bookings b on b.id = p.booking_id
      join tenants t  on t.id = p.tenant_id
     where p.created_at >= ${from}::timestamptz
       and p.created_at <  ${to}::timestamptz
       ${tenantClause}
       and (
         (p.kind = 'charge' and p.status in ('captured', 'refunded', 'partially_refunded'))
         or (p.kind = 'refund' and p.status <> 'failed')
       )
  `;
}

/** Turn a raw grouped row into a slice, quantizing the bigint strings. */
function toSlice(r: Record<string, unknown>): RevenueSlice {
  return {
    itemType: r['item_type'] as string,
    currency: r['currency'] as string,
    grossPaise: Number(r['gross'] ?? 0),
    netPaise: Number(r['net'] ?? 0),
    commissionPaise: Number(r['commission'] ?? 0),
    refundsPaise: Number(r['refunds'] ?? 0),
    bookings: Number(r['bookings'] ?? 0),
  };
}

/**
 * Platform-wide sales in a window, split by what was sold and by currency.
 *
 * Returns one slice per (item type, currency) that saw money. The caller sums
 * for a total — safe because a booking has exactly one item type, so no
 * booking is counted twice.
 */
export async function getPlatformRevenue(from: string, to: string): Promise<RevenueSlice[]> {
  const raw = await db.execute<Record<string, unknown>>(sql`
    with money as (${moneyRows(from, to)})
    select item_type,
           currency,
           coalesce(sum(gross), 0)                                          as gross,
           coalesce(sum(base) filter (where payout_basis), 0)
             - coalesce(sum(commission) filter (where payout_basis), 0)     as net,
           coalesce(sum(commission) filter (where payout_basis), 0)         as commission,
           coalesce(-sum(gross) filter (where kind = 'refund'), 0)          as refunds,
           count(distinct booking_id)
             filter (where kind = 'charge' and payout_basis)                 as bookings
      from money
     group by item_type, currency
     order by item_type, currency
  `);
  return (raw as unknown as Record<string, unknown>[]).map(toSlice);
}

/** One sellable thing, with what it has taken. */
export interface ItemRevenue extends RevenueSlice {
  /** The event / membership / venue this money belongs to. */
  itemId: string;
}

/** What `getTenantItemRevenue` groups by. */
export type RevenueGrouping = 'event' | 'membership' | 'venue';

/** What one grouping found: the rows, and anything it could not place. */
export interface TenantItemRevenueResult {
  items: ItemRevenue[];
  /**
   * Money of this kind that carries no id to attribute it to — a slot booking
   * with no venue, or an event booking whose `item_data` never got stamped.
   *
   * Returned rather than discarded so the caller can say so. These totals DO
   * count towards the dashboard's cards, so dropping them silently would let a
   * tab and a card disagree with nothing on screen explaining the gap.
   */
  unattributed: RevenueSlice[];
}

/**
 * One organisation's sales, grouped by the thing sold, so the admin tenant
 * tabs can put money beside each event, plan or venue.
 *
 * The window is open-ended by default: an admin asking "how much has this
 * event taken" means since it existed, not this month.
 */
export async function getTenantItemRevenue(
  tenantId: string,
  grouping: RevenueGrouping,
  from: string,
  to: string,
): Promise<TenantItemRevenueResult> {
  // What identifies the thing sold, per grouping. Events and memberships are
  // stamped into the booking's item_data; a slot booking carries its venue.
  const key =
    grouping === 'venue'
      ? sql`venue_id`
      : grouping === 'event'
        ? sql`nullif(item_data->>'eventId', '')::uuid`
        : sql`nullif(item_data->>'membershipId', '')::uuid`;
  const wanted = grouping === 'venue' ? 'slot' : grouping;

  // Grouped including the unattributable, which come back with a null id
  // rather than being filtered away.
  const raw = await db.execute<Record<string, unknown>>(sql`
    with money as (${moneyRows(from, to, { tenantId })})
    select ${key}                                                           as item_id,
           item_type,
           currency,
           coalesce(sum(gross), 0)                                          as gross,
           coalesce(sum(base) filter (where payout_basis), 0)
             - coalesce(sum(commission) filter (where payout_basis), 0)     as net,
           coalesce(sum(commission) filter (where payout_basis), 0)         as commission,
           coalesce(-sum(gross) filter (where kind = 'refund'), 0)          as refunds,
           count(distinct booking_id)
             filter (where kind = 'charge' and payout_basis)                 as bookings
      from money
     where item_type = ${wanted}
     group by 1, 2, 3
  `);

  const items: ItemRevenue[] = [];
  const unattributed: RevenueSlice[] = [];
  for (const r of raw as unknown as Record<string, unknown>[]) {
    const itemId = r['item_id'] as string | null;
    if (itemId) items.push({ ...toSlice(r), itemId });
    else unattributed.push(toSlice(r));
  }
  return { items, unattributed };
}
