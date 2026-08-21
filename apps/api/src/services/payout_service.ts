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
