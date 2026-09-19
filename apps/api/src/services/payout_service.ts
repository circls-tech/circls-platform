/**
 * Payout service — Circls-as-merchant model.
 *
 * Circls collects all customer payments into its own account. Each settlement
 * week the `payout-reconciliation` worker computes what Circls owes each venue
 * — gross captured charges, minus refunds, minus a per-tenant commission — and
 * inserts one `pending` payouts row per tenant. Platform ops then transfers the
 * net out-of-band (NEFT/UPI; no bank details are stored in-app) and marks the
 * row `paid` with a reference via `executePayout()`.
 *
 *   reconcileWeeklyPayouts()  → worker, Mondays (or on demand via
 *                               POST /v1/admin/payouts/reconcile): insert pending rows.
 *   listPayouts()             → admin read (GET /v1/admin/payouts).
 *   executePayout()           → admin write (POST /v1/admin/payouts/:id/execute).
 */
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { payments, payouts, tenants } from '../db/schema/index.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';

/**
 * True when a refund row `p` is against a charge that was ever going to reach
 * the partner: one with a settlement hold, or one already released. The same
 * rule as the reconciler's refund filter, as raw SQL over alias `p`, so the
 * breakdown can never classify a refund differently from the payout it
 * explains.
 */
const CREDITABLE_CHARGE = sql`exists (
  select 1 from payments ch
   where ch.kind = 'charge'
     and ch.booking_id = p.booking_id
     and (p.metadata->>'chargePaymentId' is null
          or ch.id::text = p.metadata->>'chargePaymentId')
     and (ch.settlement_hold_until is not null or ch.settlement_released_at is not null)
)`;

/**
 * Clamp a settlement period's raw commission so net (= gross − refunds −
 * commission) can never go negative from the commission alone, and never
 * below zero.
 *
 * The commission itself is now computed per payment: snapshotted into
 * payments.partner_commission_paise at charge time (rate edits only affect
 * new sales), with legacy NULL rows falling back to the tenant's current
 * commission_bps applied per payment. Policy: commission is charged on GROSS
 * — a customer refund does not claw back Circls's cut on that sale.
 */
export function clampCommissionPaise(
  grossPaise: number,
  refundsPaise: number,
  rawCommissionPaise: number,
): number {
  return Math.max(0, Math.min(rawCommissionPaise, grossPaise - refundsPaise));
}

/** A settlement week [start, end) in UTC. `end` is exclusive. */
export interface SettlementWeek {
  start: Date;
  end: Date;
}

/**
 * The most-recently-completed UTC week relative to `now`, aligned to Monday
 * 00:00 UTC. Run on Monday, this returns the previous Mon→Sun window.
 */
export function priorWeek(now: Date): SettlementWeek {
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  // getUTCDay(): Sun=0..Sat=6. Days since the most recent Monday.
  const sinceMonday = (midnight.getUTCDay() + 6) % 7;
  const end = new Date(midnight.getTime() - sinceMonday * 86_400_000); // this week's Monday
  const start = new Date(end.getTime() - 7 * 86_400_000); // previous Monday
  return { start, end };
}

/**
 * Worker handler. Computes per-tenant net owed for the prior settlement week
 * and inserts one `pending` payout per tenant. Idempotent: the unique index on
 * (tenant_id, period_start, period_end) makes a re-run a no-op.
 *
 * Windowing: gross counts captured charges whose funds were RELEASED in the
 * week (settlement_released_at), so money still under hold isn't paid early.
 * Advances count by advance_released_at (stamped at capture) — they pay out a
 * slice of a charge's net before its hold releases; the final tranche recoups
 * them, so cross-week totals are unchanged. Refunds count by created_at in
 * the week. A refund that lands in a later week than its charge nets against
 * that later week — acceptable for an ops-reviewed batch; ops can adjust
 * before marking paid.
 *
 * @returns the number of payout rows inserted.
 */
export async function reconcileWeeklyPayouts(now = new Date()): Promise<number> {
  const { start, end } = priorWeek(now);

  // Gross: captured charges released this week, grouped by tenant + currency
  // (a tenant's venues share one country, so one currency — but never sum
  // mixed minor units if data disagrees). A charge keeps counting toward gross
  // even after a (partial) refund flips its status, so include
  // refunded/partially_refunded too.
  //
  // commission: per-payment snapshots (payments.partner_commission_paise),
  // with legacy NULL rows falling back to the tenant's CURRENT commission_bps
  // applied per payment. Bigint division truncates toward zero — for these
  // non-negative operands that's floor, matching the old Math.floor, though
  // per-payment flooring can differ from the old weekly-aggregate floor by
  // < 1 paise per payment (in the partner's favour; accepted).
  //
  // advanceRecouped: finals released this week net out their own already-PAID
  // advances (advance_released_at guard — an unreleased advance was never
  // paid, so recouping it would short the partner).
  const grossRows = await db
    .select({
      tenantId: payments.tenantId,
      currency: payments.currency,
      gross: sql<number>`coalesce(sum(coalesce(${payments.settleBasePaise}, ${payments.amountPaise})), 0)::bigint`,
      commission: sql<number>`coalesce(sum(coalesce(${payments.partnerCommissionPaise}, (coalesce(${payments.settleBasePaise}, ${payments.amountPaise}) * ${tenants.commissionBps}) / 10000)), 0)::bigint`,
      advanceRecouped: sql<number>`coalesce(sum(case when ${payments.advanceReleasedAt} is not null then coalesce(${payments.advancePaise}, 0) else 0 end), 0)::bigint`,
    })
    .from(payments)
    .innerJoin(tenants, eq(tenants.id, payments.tenantId))
    .where(
      and(
        eq(payments.kind, 'charge'),
        sql`${payments.status} in ('captured', 'refunded', 'partially_refunded')`,
        gte(payments.settlementReleasedAt, start),
        lt(payments.settlementReleasedAt, end),
      ),
    )
    .groupBy(payments.tenantId, payments.currency);

  // Advances: charges whose advance tranche became payable this week (stamped
  // at capture). A tenant can have advances without any released settlement —
  // that alone earns a payout row.
  const advanceRows = await db
    .select({
      tenantId: payments.tenantId,
      currency: payments.currency,
      advances: sql<number>`coalesce(sum(coalesce(${payments.advancePaise}, 0)), 0)::bigint`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.kind, 'charge'),
        sql`${payments.status} in ('captured', 'refunded', 'partially_refunded')`,
        gte(payments.advanceReleasedAt, start),
        lt(payments.advanceReleasedAt, end),
      ),
    )
    .groupBy(payments.tenantId, payments.currency);

  // Refunds are deducted only when their charge was ever going to reach the
  // partner — it has a settlement hold (released in time) or has already been
  // released. A payment that succeeds after its booking was cancelled (a late
  // UPI success) is refunded automatically and never held, so its gross never
  // reaches a payout; deducting its refund charged the partner for a sale they
  // never had. Saur Grapes lost ₹614.17 to exactly this in the week of 17 Aug.
  // The refund row names its charge in metadata.chargePaymentId; older rows
  // without it fall back to any charge on the same booking.
  //
  // Refunds: refund rows created this week. Deduct at the settle value —
  // refunded customer cash plus any Circls-funded discount clawed back
  // (refund_service stores it negated in settle_base_paise; see
  // computeSettleRefundPaise). Legacy rows with NULL settle_base_paise fall
  // back to customer cash, the pre-clawback behaviour.
  const refundRows = await db
    .select({
      tenantId: payments.tenantId,
      currency: payments.currency,
      refunds: sql<number>`coalesce(-sum(coalesce(${payments.settleBasePaise}, ${payments.amountPaise})), 0)::bigint`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.kind, 'refund'),
        sql`${payments.status} <> 'failed'`,
        gte(payments.createdAt, start),
        lt(payments.createdAt, end),
        sql`exists (
          select 1 from payments ch
           where ch.kind = 'charge'
             and ch.booking_id = ${payments.bookingId}
             and (${payments.metadata}->>'chargePaymentId' is null
                  or ch.id::text = ${payments.metadata}->>'chargePaymentId')
             and (ch.settlement_hold_until is not null or ch.settlement_released_at is not null)
        )`,
      ),
    )
    .groupBy(payments.tenantId, payments.currency);

  // Merge the three aggregates per (tenant, currency). Keys must span gross
  // AND advance rows: an advances-only tenant (money captured, event not yet
  // over) still earns a payout row this week.
  interface Tranches {
    tenantId: string;
    currency: string;
    gross: number;
    commission: number;
    advanceRecouped: number;
    advances: number;
    refunds: number;
  }
  const byKey = new Map<string, Tranches>();
  const entry = (tenantId: string, currency: string): Tranches => {
    const key = `${tenantId}|${currency}`;
    let e = byKey.get(key);
    if (!e) {
      e = { tenantId, currency, gross: 0, commission: 0, advanceRecouped: 0, advances: 0, refunds: 0 };
      byKey.set(key, e);
    }
    return e;
  };
  for (const g of grossRows) {
    const e = entry(g.tenantId, g.currency);
    e.gross = Number(g.gross);
    e.commission = Number(g.commission);
    e.advanceRecouped = Number(g.advanceRecouped);
  }
  for (const a of advanceRows) entry(a.tenantId, a.currency).advances = Number(a.advances);
  for (const r of refundRows) entry(r.tenantId, r.currency).refunds = Number(r.refunds);

  // The payouts unique index is one row per (tenant, period) — a tenant with
  // charges in TWO currencies in one week can't be reconciled automatically
  // (onConflictDoNothing would silently drop the second currency's money).
  // Skip such tenants with a loud log so ops reconciles by hand.
  //
  // Deliberate change from the pre-advances version: the count now spans ALL
  // activity (gross, advances, refunds), so a refund-only second currency —
  // previously ignored silently — also trips the skip. Anomalous data now
  // fails loud instead of half-reconciling.
  const currencyCount = new Map<string, number>();
  for (const e of byKey.values()) {
    currencyCount.set(e.tenantId, (currencyCount.get(e.tenantId) ?? 0) + 1);
  }

  const toInsert = [...byKey.values()]
    .filter((e) => {
      if ((currencyCount.get(e.tenantId) ?? 0) <= 1) return true;
      logger.error(
        { tenantId: e.tenantId, start, end },
        'weekly_payout_mixed_currency_tenant_skipped',
      );
      return false;
    })
    .map((e) => {
      const commission = clampCommissionPaise(e.gross, e.refunds, e.commission);
      // Row identity: net = gross − refunds − commission + advances − recoup.
      // A charge captured AND released in the same week fires both tranches,
      // which cancel — degenerating to plain net.
      const net = e.gross - e.refunds - commission + e.advances - e.advanceRecouped;
      return { ...e, commission, net };
    })
    // Nothing owed (e.g. refunds ≥ gross) → no payout row this week. With
    // advances in play a negative week can mean Circls already paid money it
    // can't recoup from this week's activity — log loudly so ops follows up
    // out-of-band (proper carry-forward is a follow-up).
    .filter((p) => {
      if (p.net > 0) return true;
      if (p.net < 0) {
        logger.error(
          { tenantId: p.tenantId, currency: p.currency, net: p.net, start, end },
          'weekly_payout_negative_net_skipped',
        );
      }
      return false;
    });

  if (toInsert.length === 0) {
    logger.debug({ start, end }, 'weekly_payout_no_rows');
    return 0;
  }

  const inserted = await db
    .insert(payouts)
    .values(
      toInsert.map((p) => ({
        tenantId: p.tenantId,
        provider: 'external' as const,
        periodStart: start,
        periodEnd: end,
        grossPaise: p.gross,
        refundsPaise: p.refunds,
        commissionPaise: p.commission,
        advancesPaise: p.advances,
        advanceRecoupedPaise: p.advanceRecouped,
        amountPaise: p.net,
        currency: p.currency,
        status: 'pending',
        reconciledAt: new Date(),
        metadata: {},
      })),
    )
    .onConflictDoNothing({
      target: [payouts.tenantId, payouts.periodStart, payouts.periodEnd],
    })
    .returning({ id: payouts.id });

  logger.info({ count: inserted.length, start, end }, 'weekly_payout_reconciled');
  return inserted.length;
}

export interface ListPayoutsInput {
  status?: 'pending' | 'paid';
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface PayoutListItem {
  id: string;
  tenantId: string;
  tenantName: string;
  periodStart: string | null;
  periodEnd: string | null;
  grossPaise: number;
  refundsPaise: number;
  commissionPaise: number;
  advancesPaise: number;
  advanceRecoupedPaise: number;
  amountPaise: number;
  currency: string;
  status: string;
  paidAt: string | null;
  paidReference: string | null;
  createdAt: string;
}

export interface PayoutListPage {
  rows: PayoutListItem[];
  nextCursor: string | null;
}

function encodeCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}
function decodeCursor(cursor: string): { ts: string; id: string } | null {
  const idx = cursor.lastIndexOf('|');
  if (idx === -1) return null;
  const ts = cursor.slice(0, idx);
  const id = cursor.slice(idx + 1);
  if (!ts || !id) return null;
  return { ts, id };
}

/** Paginated payouts list (newest first), with the venue's name joined in. */
export async function listPayouts(input: ListPayoutsInput): Promise<PayoutListPage> {
  const limit = Math.min(input.limit ?? 50, 200);
  const conditions = [sql`1=1`];
  if (input.status) conditions.push(sql`p.status = ${input.status}`);
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (decoded) {
      conditions.push(
        sql`(p.created_at, p.id) < (${decoded.ts}::timestamptz, ${decoded.id}::uuid)`,
      );
    }
  }
  const whereClause = conditions.reduce((acc, c) => sql`${acc} AND ${c}`);

  const raw = await db.execute<Record<string, unknown>>(sql`
    SELECT
      p.id, p.tenant_id, t.name AS tenant_name,
      p.period_start, p.period_end,
      p.gross_paise, p.refunds_paise, p.commission_paise,
      p.advances_paise, p.advance_recouped_paise, p.amount_paise,
      p.currency, p.status, p.paid_at, p.paid_reference, p.created_at
    FROM payouts p
    JOIN tenants t ON t.id = p.tenant_id
    WHERE ${whereClause}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ${limit + 1}
  `);

  const rows = raw as unknown as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const items: PayoutListItem[] = page.map((r) => ({
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    tenantName: r['tenant_name'] as string,
    periodStart: r['period_start'] ? new Date(r['period_start'] as string).toISOString() : null,
    periodEnd: r['period_end'] ? new Date(r['period_end'] as string).toISOString() : null,
    grossPaise: Number(r['gross_paise'] ?? 0),
    refundsPaise: Number(r['refunds_paise'] ?? 0),
    commissionPaise: Number(r['commission_paise'] ?? 0),
    advancesPaise: Number(r['advances_paise'] ?? 0),
    advanceRecoupedPaise: Number(r['advance_recouped_paise'] ?? 0),
    amountPaise: Number(r['amount_paise'] ?? 0),
    currency: r['currency'] as string,
    status: r['status'] as string,
    paidAt: r['paid_at'] ? new Date(r['paid_at'] as string).toISOString() : null,
    paidReference: (r['paid_reference'] as string | null) ?? null,
    createdAt: new Date(r['created_at'] as string).toISOString(),
  }));

  let nextCursor: string | null = null;
  if (hasMore && page.length > 0) {
    const last = page[page.length - 1]!;
    nextCursor = encodeCursor(new Date(last['created_at'] as string).toISOString(), last['id'] as string);
  }
  return { rows: items, nextCursor };
}

/** One line of a payout breakdown: what a slice of the money was for. */
export interface PayoutBreakdownLine {
  /** 'event' | 'membership' | 'venue' for item lines; 'consumer' for people. */
  kind: string;
  /** Event / membership / venue / user id. Null when it can't be attributed. */
  id: string | null;
  /** Event name, membership name, venue name, or the customer's name. */
  label: string;
  /** Venue an event belongs to; null for org-scoped events and other kinds. */
  venueName: string | null;
  /** Phone or email, on consumer lines only. */
  contact: string | null;
  grossPaise: number;
  refundsPaise: number;
  commissionPaise: number;
  advancesPaise: number;
  advanceRecoupedPaise: number;
  /** gross − refunds − commission + advances − recouped, for this line. */
  netPaise: number;
  /** Distinct bookings behind the line. */
  bookings: number;
}

export interface PayoutBreakdown {
  payoutId: string;
  currency: string;
  /** The payout's own stored total, for reconciliation. */
  amountPaise: number;
  /** What the attributed lines add up to. */
  attributedPaise: number;
  /**
   * amountPaise − attributedPaise. Normally 0. It can be non-zero for two
   * honest reasons: a payment with no booking behind it, and the commission
   * clamp, which the reconciler applies to the tenant's weekly total rather
   * than per line. Surfaced rather than hidden so the numbers can be trusted.
   */
  unattributedPaise: number;
  /**
   * Refunds in the window that were not deducted because their charge never
   * reached the partner.
   */
  uncreditedRefundsPaise: number;
  /** What the payout row itself recorded as refunds. */
  storedRefundsPaise: number;
  /**
   * What the breakdown deducts as refunds now. When the payout stored more
   * than this — by exactly uncreditedRefundsPaise — it was reconciled before
   * uncredited refunds were excluded, and the partner is owed the difference.
   * Comparing these two is exact, unlike reading the residual, which also
   * carries the commission clamp and unattributable payments.
   */
  attributedRefundsPaise: number;
  /** What the partner is being paid for: events, memberships, venue bookings. */
  byItem: PayoutBreakdownLine[];
  /** Who paid: one line per customer. */
  byConsumer: PayoutBreakdownLine[];
  /**
   * Who paid, one line per booking — so each line can say what it was for,
   * which tier, and how its refunds relate to the money actually paid out.
   * Sorted by customer, so a person's bookings sit together.
   */
  byBooking: PayoutBookingLine[];
}

/** Where a line's refunds sit relative to its charge being paid out. */
export type RefundTiming =
  /** No refund on this line in this payout. */
  | 'none'
  /** The charge was paid out in this same payout, so they net off here. */
  | 'same_payout'
  /**
   * The charge was paid out in an earlier payout and the refund claws it back
   * now — which is why such a line can show a gross of 0 against a refund.
   */
  | 'earlier_payout'
  /** Refunded before the charge was paid out; the charge arrives later. */
  | 'not_yet_paid'
  /**
   * The charge was never going to be paid out to the partner — it has no
   * settlement hold and was never released. Happens when a payment succeeds
   * after its booking was already cancelled (a late UPI success, say): the
   * customer is refunded automatically and the partner never had the sale.
   */
  | 'never_credited';

export interface PayoutBookingLine {
  bookingId: string | null;
  consumerId: string | null;
  customerName: string;
  contact: string | null;
  /** 'event' | 'membership' | 'slot', or null when it can't be attributed. */
  itemType: string | null;
  /** What it was for: the event, the plan, or the venue. */
  itemName: string | null;
  venueName: string | null;
  /** Tickets by tier for an event ("2× Gold"), the plan tier for a
   *  membership, or the court(s) for a venue booking. */
  detail: string | null;
  grossPaise: number;
  refundsPaise: number;
  commissionPaise: number;
  advancesPaise: number;
  advanceRecoupedPaise: number;
  netPaise: number;
  /**
   * The part of this line's refunds that is more than the partner was paid for
   * the booking: the gateway fee on the original charge, which the customer
   * gets back but partners bear on a refund. Zero when there's no refund.
   */
  refundFeePaise: number;
  refundTiming: RefundTiming;
  /** For an 'earlier_payout' refund: the payout that paid the original charge. */
  paidInPayout: { id: string; periodStart: string; periodEnd: string } | null;
  /**
   * A refund in this window that is NOT deducted, because its charge never
   * reached the partner (refundTiming 'never_credited'). Shown for the
   * record; it is in no total.
   */
  uncreditedRefundPaise: number;
}

interface AttributedRow {
  bookingId: string | null;
  itemType: string | null;
  itemId: string | null;
  itemName: string | null;
  venueName: string | null;
  consumerId: string | null;
  consumerName: string | null;
  consumerContact: string | null;
  gross: number;
  commission: number;
  advances: number;
  advanceRecouped: number;
  refunds: number;
  /** Refunds in the window the reconciler does not deduct — see CREDITABLE_CHARGE. */
  uncredited: number;
}

function emptyLine(
  kind: string,
  id: string | null,
  label: string,
  venueName: string | null,
  contact: string | null,
): PayoutBreakdownLine {
  return {
    kind,
    id,
    label,
    venueName,
    contact,
    grossPaise: 0,
    refundsPaise: 0,
    commissionPaise: 0,
    advancesPaise: 0,
    advanceRecoupedPaise: 0,
    netPaise: 0,
    bookings: 0,
  };
}

/**
 * What a payout was actually for, split by item and by customer.
 *
 * Rebuilds the payout's contributing payments from the SAME window and filters
 * the weekly reconciler used — the payout row carries its period, tenant and
 * currency — so the lines reconcile with the amount that was paid. Anything
 * that cannot be attributed is reported as a residual rather than quietly
 * dropped or spread across the lines.
 */
export async function getPayoutBreakdown(payoutId: string): Promise<PayoutBreakdown | null> {
  const [po] = (await db.execute<Record<string, unknown>>(sql`
    select id, tenant_id, currency, period_start, period_end, amount_paise, refunds_paise
      from payouts where id = ${payoutId}::uuid
  `)) as unknown as Record<string, unknown>[];
  if (!po) return null;

  // A legacy payout with no period can't be reconstructed: there is no window
  // to select its payments by.
  if (po['period_start'] === null || po['period_end'] === null) {
    return {
      payoutId,
      currency: po['currency'] as string,
      amountPaise: Number(po['amount_paise']),
      attributedPaise: 0,
      unattributedPaise: Number(po['amount_paise']),
      uncreditedRefundsPaise: 0,
      storedRefundsPaise: Number(po['refunds_paise'] ?? 0),
      attributedRefundsPaise: 0,
      byItem: [],
      byConsumer: [],
      byBooking: [],
    };
  }

  const tenantId = po['tenant_id'] as string;
  const currency = po['currency'] as string;
  const start = po['period_start'] as string;
  const end = po['period_end'] as string;

  // Mirrors reconcileWeeklyPayouts: charges released for settlement this week,
  // advance tranches that became payable this week, and refunds raised this
  // week. Each contributing payment is joined out to what it was for.
  const raw = await db.execute<Record<string, unknown>>(sql`
    with contrib as (
      select p.booking_id,
             coalesce(p.settle_base_paise, p.amount_paise) as gross,
             coalesce(p.partner_commission_paise,
                      (coalesce(p.settle_base_paise, p.amount_paise) * t.commission_bps) / 10000)
               as commission,
             case when p.advance_released_at is not null
                  then coalesce(p.advance_paise, 0) else 0 end as advance_recouped,
             0::bigint as advances,
             0::bigint as refunds,
             0::bigint as uncredited
        from payments p
        join tenants t on t.id = p.tenant_id
       where p.tenant_id = ${tenantId}::uuid
         and p.currency = ${currency}
         and p.kind = 'charge'
         and p.status in ('captured', 'refunded', 'partially_refunded')
         and p.settlement_released_at >= ${start}::timestamptz
         and p.settlement_released_at <  ${end}::timestamptz
      union all
      select p.booking_id, 0::bigint, 0::bigint, 0::bigint,
             coalesce(p.advance_paise, 0) as advances, 0::bigint, 0::bigint
        from payments p
       where p.tenant_id = ${tenantId}::uuid
         and p.currency = ${currency}
         and p.kind = 'charge'
         and p.status in ('captured', 'refunded', 'partially_refunded')
         and p.advance_released_at >= ${start}::timestamptz
         and p.advance_released_at <  ${end}::timestamptz
      union all
      select p.booking_id, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
             -coalesce(p.settle_base_paise, p.amount_paise) as refunds, 0::bigint
        from payments p
       where p.tenant_id = ${tenantId}::uuid
         and p.currency = ${currency}
         and p.kind = 'refund'
         and p.status <> 'failed'
         and p.created_at >= ${start}::timestamptz
         and p.created_at <  ${end}::timestamptz
         and ${CREDITABLE_CHARGE}
      union all
      -- Refunds the reconciler does not deduct: their charge never reached the
      -- partner. Carried as a separate amount so the line still appears and
      -- says why, without touching any total.
      select p.booking_id, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
             -coalesce(p.settle_base_paise, p.amount_paise) as uncredited
        from payments p
       where p.tenant_id = ${tenantId}::uuid
         and p.currency = ${currency}
         and p.kind = 'refund'
         and p.status <> 'failed'
         and p.created_at >= ${start}::timestamptz
         and p.created_at <  ${end}::timestamptz
         and not ${CREDITABLE_CHARGE}
    )
    select c.booking_id,
           b.item_type,
           case b.item_type
             when 'event'      then b.item_data->>'eventId'
             when 'membership' then b.item_data->>'membershipId'
             else b.venue_id::text
           end                                                   as item_id,
           case b.item_type
             when 'event'      then ev.name
             when 'membership' then mem.name
             else v.name
           end                                                   as item_name,
           case when b.item_type = 'event' then v.name else null end as venue_name,
           b.customer_user_id,
           coalesce(u.display_name, b.customer_name)             as consumer_name,
           coalesce(u.phone_e164, u.email, b.customer_contact)   as consumer_contact,
           sum(c.gross)::bigint            as gross,
           sum(c.commission)::bigint       as commission,
           sum(c.advances)::bigint         as advances,
           sum(c.advance_recouped)::bigint as advance_recouped,
           sum(c.refunds)::bigint          as refunds,
           sum(c.uncredited)::bigint       as uncredited
      from contrib c
      left join bookings b   on b.id = c.booking_id
      left join venues v     on v.id = b.venue_id
      left join users u      on u.id = b.customer_user_id
      left join events ev    on b.item_type = 'event'
                           and ev.id = (b.item_data->>'eventId')::uuid
      left join memberships mem on b.item_type = 'membership'
                           and mem.id = (b.item_data->>'membershipId')::uuid
     group by c.booking_id, b.item_type, b.item_data, b.venue_id, ev.name, mem.name, v.name,
              b.customer_user_id, u.display_name, b.customer_name,
              u.phone_e164, u.email, b.customer_contact
  `);

  const rows: AttributedRow[] = (raw as unknown as Record<string, unknown>[]).map((r) => ({
    bookingId: (r['booking_id'] as string | null) ?? null,
    itemType: (r['item_type'] as string | null) ?? null,
    itemId: (r['item_id'] as string | null) ?? null,
    itemName: (r['item_name'] as string | null) ?? null,
    venueName: (r['venue_name'] as string | null) ?? null,
    consumerId: (r['customer_user_id'] as string | null) ?? null,
    consumerName: (r['consumer_name'] as string | null) ?? null,
    consumerContact: (r['consumer_contact'] as string | null) ?? null,
    gross: Number(r['gross'] ?? 0),
    commission: Number(r['commission'] ?? 0),
    advances: Number(r['advances'] ?? 0),
    advanceRecouped: Number(r['advance_recouped'] ?? 0),
    refunds: Number(r['refunds'] ?? 0),
    uncredited: Number(r['uncredited'] ?? 0),
  }));

  const byItem = new Map<string, PayoutBreakdownLine>();
  const byConsumer = new Map<string, PayoutBreakdownLine>();

  function add(line: PayoutBreakdownLine, r: AttributedRow): void {
    line.grossPaise += r.gross;
    line.commissionPaise += r.commission;
    line.advancesPaise += r.advances;
    line.advanceRecoupedPaise += r.advanceRecouped;
    line.refundsPaise += r.refunds;
    line.netPaise =
      line.grossPaise -
      line.refundsPaise -
      line.commissionPaise +
      line.advancesPaise -
      line.advanceRecoupedPaise;
    if (r.bookingId) line.bookings += 1;
  }

  for (const r of rows) {
    // Slot bookings are attributed to their venue; an org-scoped event with no
    // venue still groups under its own name.
    const kind =
      r.itemType === 'event' ? 'event' : r.itemType === 'membership' ? 'membership' : r.itemType === 'slot' ? 'venue' : 'other';
    const itemKey = `${kind}|${r.itemId ?? 'none'}`;
    let itemLine = byItem.get(itemKey);
    if (!itemLine) {
      itemLine = emptyLine(kind, r.itemId, r.itemName ?? 'Unattributed', r.venueName, null);
      byItem.set(itemKey, itemLine);
    }
    add(itemLine, r);

    const consumerKey = r.consumerId ?? `guest|${r.consumerName ?? 'unknown'}`;
    let consumerLine = byConsumer.get(consumerKey);
    if (!consumerLine) {
      consumerLine = emptyLine(
        'consumer',
        r.consumerId,
        r.consumerName ?? 'Guest',
        null,
        r.consumerContact,
      );
      byConsumer.set(consumerKey, consumerLine);
    }
    add(consumerLine, r);
  }

  const details = await loadBookingDetails(
    rows.flatMap((r) => (r.bookingId ? [r.bookingId] : [])),
    { tenantId, currency, start, end },
  );
  const byBooking: PayoutBookingLine[] = rows.map((r) => {
    const d = r.bookingId ? details.get(r.bookingId) : undefined;
    return {
      bookingId: r.bookingId,
      consumerId: r.consumerId,
      customerName: r.consumerName ?? 'Guest',
      contact: r.consumerContact,
      itemType: r.itemType,
      itemName: r.itemName,
      venueName: r.venueName,
      detail: d?.detail ?? null,
      grossPaise: r.gross,
      refundsPaise: r.refunds,
      commissionPaise: r.commission,
      advancesPaise: r.advances,
      advanceRecoupedPaise: r.advanceRecouped,
      netPaise: r.gross - r.refunds - r.commission + r.advances - r.advanceRecouped,
      refundFeePaise: r.refunds > 0 ? (d?.refundFeePaise ?? 0) : 0,
      refundTiming:
        r.refunds > 0
          ? (d?.refundTiming ?? 'not_yet_paid')
          : r.uncredited > 0
            ? 'never_credited'
            : 'none',
      paidInPayout: r.refunds > 0 ? (d?.paidInPayout ?? null) : null,
      uncreditedRefundPaise: r.uncredited,
    };
  });
  byBooking.sort(
    (a, b) =>
      a.customerName.localeCompare(b.customerName) ||
      (a.itemName ?? '').localeCompare(b.itemName ?? ''),
  );

  const byNet = (a: PayoutBreakdownLine, b: PayoutBreakdownLine) => b.netPaise - a.netPaise;
  const itemLines = [...byItem.values()].sort(byNet);
  const attributedPaise = itemLines.reduce((sum, l) => sum + l.netPaise, 0);
  const amountPaise = Number(po['amount_paise']);

  return {
    payoutId,
    currency,
    amountPaise,
    attributedPaise,
    unattributedPaise: amountPaise - attributedPaise,
    uncreditedRefundsPaise: rows.reduce((sum, r) => sum + r.uncredited, 0),
    storedRefundsPaise: Number(po['refunds_paise'] ?? 0),
    attributedRefundsPaise: rows.reduce((sum, r) => sum + r.refunds, 0),
    byItem: itemLines,
    byConsumer: [...byConsumer.values()].sort(byNet),
    byBooking,
  };
}

interface BookingDetail {
  detail: string | null;
  refundFeePaise: number;
  refundTiming: RefundTiming;
  paidInPayout: PayoutBookingLine['paidInPayout'];
}

/**
 * Per-booking context for the "who paid" lines: what exactly was bought, and
 * how any refund in this payout relates to the original charge.
 *
 * Looks at each booking's charge across all time, not just this payout's
 * window — a refund here is often against a charge that was paid out weeks
 * earlier, and that is precisely what a partner needs to see.
 */
async function loadBookingDetails(
  bookingIds: string[],
  w: { tenantId: string; currency: string; start: string; end: string },
): Promise<Map<string, BookingDetail>> {
  const out = new Map<string, BookingDetail>();
  if (bookingIds.length === 0) return out;
  const idList = sql.join(
    bookingIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const raw = (await db.execute(sql`
    with charge as (
      select p.booking_id,
             sum(p.amount_paise)::bigint                                as cash,
             sum(coalesce(p.settle_base_paise, p.amount_paise))::bigint as base,
             -- A booking can carry more than one charge. If any of them is
             -- paid out in this payout the refund nets off here; only when
             -- none is does it claw back an earlier payout (the latest one).
             bool_or(p.settlement_released_at >= ${w.start}::timestamptz
                 and p.settlement_released_at <  ${w.end}::timestamptz)  as in_window,
             max(p.settlement_released_at)
               filter (where p.settlement_released_at < ${w.start}::timestamptz) as released_before,
             -- Whether any charge was ever going to reach the partner: one
             -- with a settlement hold is released in time; one already
             -- released has been. Neither means the partner never had it.
             bool_or(p.settlement_hold_until is not null
                  or p.settlement_released_at is not null)             as creditable
        from payments p
       where p.booking_id in (${idList})
         and p.kind = 'charge'
         and p.status in ('captured', 'refunded', 'partially_refunded')
         -- Only charges that reach the partner: on a booking that carries
         -- both kinds, summing an uncredited charge into the base would
         -- skew the refunded share the fee is worked out from.
         and (p.settlement_hold_until is not null or p.settlement_released_at is not null)
       group by p.booking_id
    ),
    refund as (
      -- Refund rows store negative amounts; flip them to positive here.
      select p.booking_id,
             (-sum(p.amount_paise))::bigint                                as cash,
             (-sum(coalesce(p.settle_base_paise, p.amount_paise)))::bigint as settle
        from payments p
       where p.booking_id in (${idList})
         and p.tenant_id = ${w.tenantId}::uuid
         and p.currency = ${w.currency}
         and p.kind = 'refund'
         and p.status <> 'failed'
         and p.created_at >= ${w.start}::timestamptz
         and p.created_at <  ${w.end}::timestamptz
         -- Deducted refunds only. A booking can carry both kinds at once (a
         -- retried payment leaves two charges), and folding an uncredited
         -- refund in here would overstate the fee on the deducted one.
         and ${CREDITABLE_CHARGE}
       group by p.booking_id
    )
    select b.id as booking_id,
           case b.item_type
             when 'event' then (
               select string_agg(t.quantity || '× ' || tt.name, ', ' order by tt.sort_order, tt.name)
                 from event_booking_tickets t
                 join event_ticket_tiers tt on tt.id = t.tier_id
                where t.booking_id = b.id)
             when 'membership' then (
               select mt.name
                 from user_memberships um
                 join membership_tiers mt on mt.id = um.membership_tier_id
                where um.id = (b.item_data->>'userMembershipId')::uuid
                   or um.payment_id in (select p.id from payments p
                                         where p.booking_id = b.id and p.kind = 'charge')
                limit 1)
             when 'slot' then coalesce(
               (select string_agg(distinct a.name, ', ')
                  from slots s join arenas a on a.id = s.arena_id
                 where s.booking_id = b.id),
               -- A cancelled booking's slots are released, so fall back to the
               -- arena recorded on the booking itself.
               (select a.name from arenas a where a.id = b.slot_arena_id))
           end                                                    as detail,
           c.cash                                                 as charge_cash,
           c.base                                                 as charge_base,
           case when not coalesce(c.creditable, false) then 'never'
                when c.in_window                   then 'within'
                when c.released_before is not null then 'before'
                else 'unpaid' end                                 as charge_when,
           r.cash                                                 as refund_cash,
           r.settle                                               as refund_settle,
           (select json_build_object('id', po.id,
                                     'periodStart', po.period_start,
                                     'periodEnd', po.period_end)
              from payouts po
             where po.tenant_id = ${w.tenantId}::uuid
               and po.currency = ${w.currency}
               and c.released_before >= po.period_start
               and c.released_before <  po.period_end
             order by po.period_start desc
             limit 1)                                             as paid_in
      from bookings b
      left join charge c on c.booking_id = b.id
      left join refund r on r.booking_id = b.id
     where b.id in (${idList})
  `)) as unknown as Record<string, unknown>[];

  for (const row of raw) {
    const chargeCash = Number(row['charge_cash'] ?? 0);
    const chargeBase = row['charge_base'] === null ? null : Number(row['charge_base']);
    const refundCash = Number(row['refund_cash'] ?? 0);
    const refundSettle = Number(row['refund_settle'] ?? 0);

    const when = row['charge_when'] as 'never' | 'before' | 'within' | 'unpaid';

    // What the partner loses beyond what they were paid for the refunded share
    // of the booking. Proportional by cash, the same way computeSettleRefundPaise
    // sizes a partial refund.
    let refundFeePaise = 0;
    // No fee on a never-credited refund: the partner never had the sale, so
    // nothing about it is theirs to bear.
    if (when !== 'never' && refundSettle > 0 && chargeCash > 0 && chargeBase !== null) {
      const baseShare = Math.round((chargeBase * refundCash) / chargeCash);
      refundFeePaise = Math.max(0, refundSettle - baseShare);
    }

    const paidIn = row['paid_in'] as { id: string; periodStart: string; periodEnd: string } | null;
    out.set(row['booking_id'] as string, {
      detail: (row['detail'] as string | null) ?? null,
      refundFeePaise,
      refundTiming:
        when === 'never'
          ? 'never_credited'
          : when === 'within'
            ? 'same_payout'
            : when === 'before'
              ? 'earlier_payout'
              : 'not_yet_paid',
      paidInPayout: when === 'before' && paidIn ? paidIn : null,
    });
  }
  return out;
}

export interface ExecutePayoutInput {
  payoutId: string;
  actorUserId: string;
  /** Bank/UPI transaction reference for the out-of-band transfer. */
  reference: string;
  note?: string | undefined;
}

/**
 * Mark a pending payout as paid after ops has transferred the money
 * out-of-band. Only `pending` payouts can be executed — re-executing a `paid`
 * one is a 409 so a double-click never double-records.
 */
export async function executePayout(input: ExecutePayoutInput): Promise<{ id: string; status: string }> {
  return db.transaction(async (tx) => {
    const [payout] = await tx.select().from(payouts).where(eq(payouts.id, input.payoutId)).limit(1);
    if (!payout) throw new NotFound('Payout not found', 'payout_not_found');
    if (payout.status !== 'pending') {
      throw new Conflict(`Payout is already ${payout.status}`, 'payout_not_pending', {
        status: payout.status,
      });
    }

    const paidAt = new Date();
    const [updated] = await tx
      .update(payouts)
      .set({
        status: 'paid',
        paidAt,
        paidReference: input.reference,
        paidByUserId: input.actorUserId,
        metadata: { ...payout.metadata, ...(input.note ? { note: input.note } : {}) },
      })
      .where(and(eq(payouts.id, input.payoutId), eq(payouts.status, 'pending')))
      .returning({ id: payouts.id, status: payouts.status });
    if (!updated) throw new Conflict('Payout is already paid', 'payout_not_pending');

    await writeAudit(
      tx,
      { tenantId: payout.tenantId, actorUserId: input.actorUserId },
      'payout.executed',
      'payout',
      payout.id,
      { status: 'pending' },
      { status: 'paid', amountPaise: payout.amountPaise, reference: input.reference },
    );

    return { id: updated.id, status: updated.status };
  });
}
