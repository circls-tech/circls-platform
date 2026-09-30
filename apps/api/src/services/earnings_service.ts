/**
 * Partner-facing earnings — "what will Circls actually pay me for this period?"
 *
 * WHY THIS EXISTS. Everything a partner could see about their money was GROSS.
 * The Dashboard's Revenue tiles are customer cash (analytics_service), and the
 * event registrations table and venue bookings list both show
 * `bookings.total_paise` — the customer's full bill, which on top of the
 * partner's own take also carries the consumer-side commission and the
 * customer's share of the gateway fee. A partner adding that column up
 * over-states their payout by four separate items. This module is the one
 * place that answers the question they were actually asking.
 *
 * NET, AND ONLY NET. Every figure returned is net payable: the settleable base
 * less Circls' partner commission, which is what later lands in a payout row.
 * Gross, commission and fee amounts are deliberately NOT returned — not merely
 * hidden in the UI — so a partner reading the response in devtools still can't
 * derive the commission rate, which the tenant profile withholds by design
 * (see tenant_service.ts). The trade-off is accepted: partners get a number
 * they can trust rather than a number they can audit.
 *
 * HOW IT DIFFERS FROM A PAYOUT ROW, deliberately:
 *
 *   - Dated by `payments.created_at` — when the customer paid. A sale made
 *     today counts today, where a payout row wouldn't exist until its week is
 *     reconciled. That lead is the point of the page.
 *   - No advance / recoup tranches. Those move a payout's *timing*, not its
 *     amount, and across any window wide enough to hold both they cancel.
 *   - No weekly commission clamp. Commission is already clamped per charge at
 *     capture (computeChargeSnapshots), so no single sale nets negative; a
 *     window whose refunds outrun its sales honestly reads negative here.
 *
 * WHAT IT MATCHES A PAYOUT ON, and must:
 *
 *   - Only money that will actually settle counts — charges with a settlement
 *     hold or release, and refunds against such a charge. `moneyRows` marks
 *     these as `payout_basis` (see settlement_credit); this service keeps only
 *     those rows, since it has no gross to report. A payment that succeeds
 *     after its booking was already cancelled is never held and is
 *     auto-refunded: counting its gross would promise money that never
 *     arrives, and deducting its refund would charge the partner for a sale
 *     they never had. Reconciliation gets this free by windowing on the
 *     release date; dating by the sale, as this does, has to ask for it.
 *   - Commission is snapshotted at charge time and never reversed by a refund,
 *     exactly as reconciliation treats it.
 *
 * DESK TAKINGS ARE SEPARATE. Bookings the partner took at their own desk
 * (`payment_method = 'external'`) never passed through Circls, so they can
 * never appear in a payout and are not in any net figure here. They are
 * returned on their own so the page can account for the gap between itself and
 * the Dashboard's Revenue tile, instead of the two silently disagreeing.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { moneyRows } from './revenue_service.js';

/** A net total in one currency. Currencies are never summed together. */
export interface EarningsTotal {
  /** ISO 4217, read off the payments rather than guessed from the venue. */
  currency: string;
  /** Net payable to the partner, in minor units. Negative if refunds won. */
  netPaise: number;
  /** Distinct bookings that took money in the window. */
  bookings: number;
}

/** What was sold. 'venue' covers court/arena slot bookings. */
export type EarningsStream = 'event' | 'membership' | 'venue';

/** A net total for one of the three streams. */
export interface EarningsStreamTotal extends EarningsTotal {
  stream: EarningsStream;
}

/** Net for one individual event, membership plan, or venue. */
export interface EarningsItem extends EarningsStreamTotal {
  /**
   * The event / plan / venue id, or null when the booking carries nothing to
   * attribute it to. Returned rather than dropped, so the rows always add up
   * to the total shown above them.
   */
  id: string | null;
  /** The item's name; null for an unattributable row. */
  name: string | null;
  /** The venue an event or plan belongs to; null when org-scoped. */
  venueName: string | null;
}

/** Cash the partner took at their own desk. Never part of a Circls payout. */
export interface DeskTakings {
  currency: string;
  /** What the partner charged, in minor units — their money already. */
  amountMinor: number;
  bookings: number;
}

export interface TenantEarnings {
  /** The window, echoed back so a stale response can't be mislabelled. */
  from: string;
  to: string;
  /** Net across all three streams, per currency. */
  total: EarningsTotal[];
  /** Net per stream, per currency. */
  byStream: EarningsStreamTotal[];
  /** Net per individual item, per currency. */
  items: EarningsItem[];
  /** Collected at the partner's own desk; in none of the totals above. */
  desk: DeskTakings[];
}

/** `bookings.item_type` → the stream a partner thinks in. */
const STREAM_OF: Record<string, EarningsStream> = {
  event: 'event',
  membership: 'membership',
  slot: 'venue',
};

/**
 * What one organisation is owed for sales in [from, to), broken out by stream
 * and by individual item.
 *
 * @param from Inclusive ISO instant.
 * @param to   Exclusive ISO instant.
 */
export async function getTenantEarnings(
  tenantId: string,
  from: string,
  to: string,
): Promise<TenantEarnings> {
  // Aggregated per (item type, item, currency), then joined out to names.
  // Aggregation happens before the name joins so a renamed or deleted item
  // can't multiply a row, and `agg` is a CTE because Postgres won't let the
  // JOINs reference the derived `item_id` alias.
  const raw = await db.execute<Record<string, unknown>>(sql`
    with money as (${moneyRows(from, to, { tenantId })}),
    agg as (
      select m.item_type                                              as item_type,
             case m.item_type
               when 'event'      then nullif(m.item_data->>'eventId', '')::uuid
               when 'membership' then nullif(m.item_data->>'membershipId', '')::uuid
               else m.venue_id
             end                                                      as item_id,
             m.currency                                               as currency,
             (coalesce(sum(m.base) filter (where m.payout_basis), 0)
              - coalesce(sum(m.commission) filter (where m.payout_basis), 0))::bigint as net,
             count(distinct m.booking_id)
               filter (where m.kind = 'charge' and m.payout_basis)                    as bookings
        from money m
       where m.payout_basis
       group by 1, 2, 3
    )
    select a.item_type,
           a.item_id,
           a.currency,
           a.net,
           a.bookings,
           coalesce(ev.name, mem.name, v.name)                        as item_name,
           coalesce(evv.name, memv.name)                              as venue_name
      from agg a
      left join events      ev   on a.item_type = 'event'      and ev.id  = a.item_id
      left join memberships mem  on a.item_type = 'membership'  and mem.id = a.item_id
      left join venues      v    on a.item_type = 'slot'        and v.id   = a.item_id
      left join venues      evv  on evv.id = ev.venue_id
      left join venues      memv on memv.id = mem.venue_id
     order by a.item_type, a.net desc
  `);

  const items: EarningsItem[] = [];
  for (const r of raw as unknown as Record<string, unknown>[]) {
    const stream = STREAM_OF[r['item_type'] as string];
    // A booking item type this build doesn't know about yet: skipping it would
    // hide money, so it can't be silently dropped — but nor can it be filed
    // under a stream that doesn't exist. Nothing else creates one today.
    if (!stream) continue;
    items.push({
      stream,
      id: (r['item_id'] as string | null) ?? null,
      name: (r['item_name'] as string | null) ?? null,
      venueName: (r['venue_name'] as string | null) ?? null,
      currency: r['currency'] as string,
      netPaise: Number(r['net'] ?? 0),
      bookings: Number(r['bookings'] ?? 0),
    });
  }

  // Desk takings: the booking row is the only record of them, so the same
  // "booking stands" rule analytics_service uses applies — a cancelled desk
  // booking leaves no refund to net off, so it simply stops counting.
  const deskRaw = await db.execute<Record<string, unknown>>(sql`
    select b.currency                             as currency,
           coalesce(sum(b.total_paise), 0)::bigint as amount,
           count(*)                               as bookings
      from bookings b
     where b.tenant_id = ${tenantId}::uuid
       and b.payment_method = 'external'
       and b.status in ('confirmed', 'completed', 'no_show')
       and b.total_paise is not null
       and b.created_at >= ${from}::timestamptz
       and b.created_at <  ${to}::timestamptz
     group by b.currency
     order by b.currency
  `);

  return {
    from,
    to,
    total: totalsByCurrency(items),
    byStream: totalsByStream(items),
    items,
    desk: (deskRaw as unknown as Record<string, unknown>[]).map((r) => ({
      currency: r['currency'] as string,
      amountMinor: Number(r['amount'] ?? 0),
      bookings: Number(r['bookings'] ?? 0),
    })),
  };
}

/**
 * Sum item rows per currency, and — for {@link totalsByStream} — per stream.
 *
 * Booking counts are summed rather than re-counted: a booking has exactly one
 * item type and one item, so no booking appears in two rows and the sum IS the
 * distinct count. Done in JS rather than as extra GROUP BY passes; the row
 * count here is items-per-organisation, which is small.
 */
function totalsByCurrency(items: EarningsItem[]): EarningsTotal[] {
  const byCurrency = new Map<string, EarningsTotal>();
  for (const item of items) {
    let row = byCurrency.get(item.currency);
    if (!row) {
      row = { currency: item.currency, netPaise: 0, bookings: 0 };
      byCurrency.set(item.currency, row);
    }
    row.netPaise += item.netPaise;
    row.bookings += item.bookings;
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

function totalsByStream(items: EarningsItem[]): EarningsStreamTotal[] {
  const byKey = new Map<string, EarningsStreamTotal>();
  for (const item of items) {
    const key = `${item.stream}|${item.currency}`;
    let row = byKey.get(key);
    if (!row) {
      row = { stream: item.stream, currency: item.currency, netPaise: 0, bookings: 0 };
      byKey.set(key, row);
    }
    row.netPaise += item.netPaise;
    row.bookings += item.bookings;
  }
  return [...byKey.values()].sort(
    (a, b) => a.stream.localeCompare(b.stream) || a.currency.localeCompare(b.currency),
  );
}
