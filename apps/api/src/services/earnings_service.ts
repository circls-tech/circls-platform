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
 * HOW MUCH HAS ACTUALLY ARRIVED. Alongside each net figure sits `paidPaise`:
 * the slice of it already transferred, re-derived from the payouts marked paid
 * (see paidOutPayment). A payout stores no per-payment breakdown, so this is
 * the only way to answer it, and it uses reconciliation's own windowing to do
 * so. It leaks nothing extra: a slice of a net figure is still net.
 *
 * It is an AMOUNT, not a filter over net, because a payout can reach the
 * partner in two instalments — an advance in the week it was released, the
 * rest when the hold expires. A charge that has had only its advance is partly
 * paid, and a row-level boolean cannot say that.
 *
 * Expect net and paid to disagree mid-cycle. The page is dated by when the
 * customer paid and a payout by when the money was released, so this week's
 * sales normally show net with nothing paid against them. That gap is the lead
 * this page exists to give; a partner reading it sees what is owed and what has
 * landed, which is the pair they actually want.
 *
 * DESK TAKINGS ARE SEPARATE. Money the partner took at their own desk —
 * walk-in bookings marked paid to them (`bookings.payment_method =
 * 'external'`) and what the members they added by hand paid them
 * (`user_memberships.desk_paid_paise`) — never passed through Circls, so it
 * can never appear in a payout and is in no net figure here. It is returned on
 * its own, bookings and memberships side by side, so a partner counting the
 * till sees both beside what Circls owes them, and so the page can account for
 * the gap between itself and the Dashboard's Revenue tile instead of the two
 * silently disagreeing.
 */
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { bookingUnitsSql } from './booking_units.js';
import { itemKeySql } from './item_key.js';
import { moneyRows } from './revenue_service.js';

/** A net total in one currency. Currencies are never summed together. */
export interface EarningsTotal {
  /** ISO 4217, read off the payments rather than guessed from the venue. */
  currency: string;
  /** Net payable to the partner, in minor units. Negative if refunds won. */
  netPaise: number;
  /**
   * How much of {@link netPaise} has already been transferred, in minor units.
   *
   * A payout's contents are not stored per payment, so this re-derives them the
   * way reconciliation windows: a charge counts once it was released inside a
   * payout marked paid, a refund once it was raised inside one. Only `paid`
   * payouts count — reconciled-but-pending is money promised, not money sent.
   *
   * USUALLY below `netPaise`, but it CAN exceed it, and that is not an error
   * to clamp away. A refund raised after the payout for those sales went out
   * lowers what the period nets without taking back what was already sent, so
   * paid stays high while net drops; reconciliation recovers the difference
   * from a future payout. Clamping would hide money the partner has been given
   * and will later have deducted.
   *
   * It also lags net mid-cycle for the ordinary reason: the page is dated by
   * when the customer paid, a payout by when the money was released, so this
   * week's sales read as net with nothing paid against them yet.
   */
  paidPaise: number;
  /** Distinct bookings that took money in the window. */
  bookings: number;
  /**
   * What was sold, counted the way a partner counts it: tickets for an event,
   * one per booking for a membership or a venue slot. Never below `bookings`.
   *
   * This is the figure to put beside the money. An event booking can carry
   * several tickets, so 14 bookings at ₹120 a ticket can honestly total
   * ₹1,800 — and a page showing "14 sales" next to it reads as wrong. An
   * event booking with no ticket lines (sold before tiers existed) counts as
   * one.
   *
   * A refund lowers the money, not this count, exactly as it leaves
   * `bookings` alone: refunds are amounts, not tickets (see bookingUnitsSql).
   */
  units: number;
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

/**
 * Cash the partner took at their own desk, in one currency. Never part of a
 * Circls payout.
 *
 * Two things are taken at a desk and both are here: walk-in bookings marked
 * paid to the partner (`bookings.payment_method = 'external'`) and members
 * added by hand with what they paid recorded (`user_memberships.desk_paid_paise`).
 * `amountMinor` is the two added up — the one figure a partner counting the
 * till wants — and each part sits beside it so the page can say where it came
 * from. There is no per-payment-method split here, as there is none for
 * bookings: the till is reconciled against the members list, which has it.
 */
export interface DeskTakings {
  currency: string;
  /** Everything taken at the desk, in minor units — the partner's money already. */
  amountMinor: number;
  /** Walk-in bookings marked paid at the desk, and what they came to. */
  bookings: number;
  bookingsMinor: number;
  /**
   * Members added by hand with an amount recorded, and what they paid. A
   * member recorded before the desk kept amounts is not counted; one recorded
   * as paying nothing (a free month) is a member who paid 0.
   */
  members: number;
  membersMinor: number;
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
             ${itemKeySql('m')}                                        as item_id,
             m.currency                                               as currency,
             (coalesce(sum(m.base) filter (where m.payout_basis), 0)
              - coalesce(sum(m.commission) filter (where m.payout_basis), 0))::bigint as net,
             -- The already-transferred slice of that same net.
             --
             -- Two tranches, because a payout can reach the partner in two
             -- instalments: the advance, sent in the week it was released, and
             -- the settlement, sent in the week the hold expired — less the
             -- advance already fronted, exactly as reconciliation deducts it.
             -- A plain filter over paid_basis cannot express this: an
             -- advanced charge is PARTLY paid, and a row-level boolean only
             -- says all or nothing.
             (coalesce(sum(case when m.advance_paid then m.advance_amount else 0 end), 0)
              + coalesce(sum(case when m.paid_basis
                                  then m.base - m.commission - m.advance_amount
                                  else 0 end), 0))::bigint          as paid,
             count(distinct m.booking_id)
               filter (where m.kind = 'charge' and m.payout_basis)                    as bookings
        from money m
       where m.payout_basis
       group by 1, 2, 3
    ),
    -- Units sold per item: the tickets on an event booking, one for anything
    -- else. Summed over DISTINCT charge bookings rather than over money rows,
    -- because a booking that carries two charges (a retried payment) appears
    -- twice there and would count its tickets twice. The same bookings the
    -- bookings count above picks, so the two never disagree about what sold.
    sold as (
      select distinct m.item_type         as item_type,
                      ${itemKeySql('m')}  as item_id,
                      m.currency          as currency,
                      m.booking_id        as booking_id
        from money m
       where m.kind = 'charge' and m.payout_basis
    ),
    units as (
      select s.item_type,
             s.item_id,
             s.currency,
             sum(${bookingUnitsSql(sql`s.booking_id`, sql`s.item_type`)})::int as units
        from sold s
       group by 1, 2, 3
    )
    select a.item_type,
           a.item_id,
           a.currency,
           a.net,
           a.paid,
           a.bookings,
           coalesce(u.units, 0)                                       as units,
           coalesce(ev.name, mem.name, v.name)                        as item_name,
           coalesce(evv.name, memv.name)                              as venue_name
      from agg a
      left join units u on u.item_type = a.item_type
                       and u.item_id is not distinct from a.item_id
                       and u.currency = a.currency
      left join events      ev   on a.item_type = 'event'      and ev.id  = a.item_id
      left join memberships mem  on a.item_type = 'membership'  and mem.id = a.item_id
      left join venues      v    on a.item_type = 'slot'        and v.id   = a.item_id
      left join venues      evv  on evv.id = ev.venue_id
      left join venues      memv on memv.id = mem.venue_id
     order by a.item_type, a.net desc
  `);

  const items: EarningsItem[] = [];
  for (const r of raw as unknown as Record<string, unknown>[]) {
    const itemType = r['item_type'] as string;
    const stream = STREAM_OF[itemType];
    // A booking item type this build doesn't know about — a fourth value added
    // to the item_type enum without this map being extended. It can't be filed
    // under a stream that doesn't exist, but dropping it quietly would take its
    // money out of the partner's headline total with nothing to show for it.
    // So it is dropped loudly: the figure is still understated until someone
    // extends STREAM_OF, and the log is what tells them to.
    if (!stream) {
      logger.error(
        { tenantId, itemType, netPaise: Number(r['net'] ?? 0), currency: r['currency'] },
        'earnings_unknown_item_type_excluded',
      );
      continue;
    }
    items.push({
      stream,
      id: (r['item_id'] as string | null) ?? null,
      name: (r['item_name'] as string | null) ?? null,
      venueName: (r['venue_name'] as string | null) ?? null,
      currency: r['currency'] as string,
      netPaise: Number(r['net'] ?? 0),
      paidPaise: Number(r['paid'] ?? 0),
      bookings: Number(r['bookings'] ?? 0),
      units: Number(r['units'] ?? 0),
    });
  }

  // Desk takings: money that never passed through Circls, so the row that
  // records it is the only evidence there is. Two kinds, kept apart so the
  // page can say which is which, then added up per currency:
  //
  //   - Walk-in bookings marked paid to the partner. The same "booking stands"
  //     rule analytics_service uses applies — a cancelled desk booking leaves
  //     no refund to net off, so it simply stops counting.
  //   - Members added by hand, with what they paid written on the row
  //     (`desk_paid_paise`, see memberships_service.addExternalMember). A plan
  //     stores no currency, so it is derived the way checkout derives it
  //     (payments_service.resolvePaymentContext): the venue's country for a
  //     venue-scoped plan, else the organisation's — the same US spellings
  //     lib/gateway.ts isUsCountry accepts. A cancelled member stops counting
  //     for the reason a cancelled booking does; an expired one still paid.
  //     `user_id is null` is belt and braces: a consumer purchase never has an
  //     amount here, its money is on `payments`. A member recorded before the
  //     desk kept amounts has nothing to count.
  //
  // Dated by `created_at` in both cases — the day the desk took the money —
  // as the circls figures above are dated by the day the customer paid.
  const deskRaw = await db.execute<Record<string, unknown>>(sql`
    with desk_bookings as (
      select b.currency::text                        as currency,
             coalesce(sum(b.total_paise), 0)::bigint as amount,
             count(*)::int                           as n
        from bookings b
       where b.tenant_id = ${tenantId}::uuid
         and b.payment_method = 'external'
         and b.status in ('confirmed', 'completed', 'no_show')
         and b.total_paise is not null
         and b.created_at >= ${from}::timestamptz
         and b.created_at <  ${to}::timestamptz
       group by b.currency
    ),
    desk_members as (
      select case when upper(btrim(coalesce(nullif(btrim(v.country), ''), t.country, '')))
                       in ('USA', 'US', 'UNITED STATES', 'UNITED STATES OF AMERICA')
                  then 'USD' else 'INR' end              as currency,
             coalesce(sum(um.desk_paid_paise), 0)::bigint as amount,
             count(*)::int                              as n
        from user_memberships um
        join memberships m on m.id = um.membership_id
        join tenants     t on t.id = m.tenant_id
        left join venues v on v.id = m.venue_id
       where m.tenant_id = ${tenantId}::uuid
         and um.user_id is null
         and um.desk_paid_paise is not null
         and um.status <> 'cancelled'
         and um.created_at >= ${from}::timestamptz
         and um.created_at <  ${to}::timestamptz
       group by 1
    )
    select coalesce(b.currency, m.currency) as currency,
           coalesce(b.amount, 0)::bigint    as bookings_amount,
           coalesce(b.n, 0)                 as bookings,
           coalesce(m.amount, 0)::bigint    as members_amount,
           coalesce(m.n, 0)                 as members
      from desk_bookings b
      full outer join desk_members m on m.currency = b.currency
     order by 1
  `);

  return {
    from,
    to,
    total: totalsByCurrency(items),
    byStream: totalsByStream(items),
    items,
    desk: (deskRaw as unknown as Record<string, unknown>[]).map((r) => {
      // bigint comes back from pg as a string.
      const bookingsMinor = Number(r['bookings_amount'] ?? 0);
      const membersMinor = Number(r['members_amount'] ?? 0);
      return {
        currency: r['currency'] as string,
        amountMinor: bookingsMinor + membersMinor,
        bookings: Number(r['bookings'] ?? 0),
        bookingsMinor,
        members: Number(r['members'] ?? 0),
        membersMinor,
      };
    }),
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
      row = { currency: item.currency, netPaise: 0, paidPaise: 0, bookings: 0, units: 0 };
      byCurrency.set(item.currency, row);
    }
    row.netPaise += item.netPaise;
    row.paidPaise += item.paidPaise;
    row.bookings += item.bookings;
    row.units += item.units;
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

function totalsByStream(items: EarningsItem[]): EarningsStreamTotal[] {
  const byKey = new Map<string, EarningsStreamTotal>();
  for (const item of items) {
    const key = `${item.stream}|${item.currency}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        stream: item.stream,
        currency: item.currency,
        netPaise: 0,
        paidPaise: 0,
        bookings: 0,
        units: 0,
      };
      byKey.set(key, row);
    }
    row.netPaise += item.netPaise;
    row.paidPaise += item.paidPaise;
    row.bookings += item.bookings;
    row.units += item.units;
  }
  return [...byKey.values()].sort(
    (a, b) => a.stream.localeCompare(b.stream) || a.currency.localeCompare(b.currency),
  );
}
