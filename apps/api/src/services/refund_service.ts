/**
 * Refund service — Phase 14.
 *
 * Refund engine branches by the charge row's provider:
 *   - gateway providers (razorpay, stripe, cashfree) → call the gateway's
 *     refundPayment(); persist the provider refund id.
 *   - stub      → no provider call; status='processed' instantly.
 *   - external  → no provider call; cash refund handled offline at the venue.
 *
 * A booking can carry more than one charge (the customer switched gateway
 * mid-checkout, or an INR order failed over), so refunds target one charge
 * and count earlier refunds per charge.
 *
 * Weekly payout reconciliation lives in `payout_service.ts`.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { couponRedemptions } from '../db/schema/coupon_redemptions.js';
import { payments } from '../db/schema/payments.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { writeSystemAudit } from '../lib/audit.js';
import { getGateway, isGatewayProvider } from '../lib/gateway.js';
import { logger } from '../lib/logger.js';

/**
 * Structural type satisfied by both `db` (PgDatabase) and any drizzle tx
 * (PgTransaction extends PgDatabase). Same trick as `lib/audit.Inserter`.
 */
export type RefundExec = Pick<typeof db, 'select' | 'insert' | 'update'>;

export interface IssueRefundInput {
  bookingId: string;
  /** Refund amount in paise; positive. */
  amountPaise: number;
  reason: string;
  /** Null for system-issued refunds (e.g. auto-refund of an orphaned capture). */
  actorUserId: string | null;
  /**
   * The charge to refund. Omitted: the booking's refundable charge (see
   * selectRefundableCharge). Auto-refunds of a specific capture pass it.
   */
  chargePaymentId?: string | undefined;
  /**
   * The refunded charge was never a sale — a duplicate payment for a booking
   * another charge already paid. Its refund leaves the partner's payout
   * untouched (the charge's own payout fields are zeroed by the caller).
   */
  settleNeutral?: boolean | undefined;
}

export interface IssueRefundResult {
  paymentId: string;
  providerRefundId?: string;
  status: 'pending' | 'processed' | 'failed';
}

export interface SettleRefundInput {
  /** Charge amount_paise (customer cash, > 0 — a positive refund passing the remaining-check implies ≥ 1). */
  chargeAmountPaise: number;
  /** Circls-funded discount on the sale (coupon_redemptions with funder='platform'); 0 if none. */
  platformDiscountPaise: number;
  /** Consumer-side commission (K) baked into the charge's amount_paise;
   *  0 for legacy rows (NULL snapshot). */
  consumerCommissionPaise: number;
  /** Cumulative cash refunded against the charge, including this refund. */
  totalRefundedPaise: number;
  /** Settle-side deduction already recorded by earlier refunds of this charge. */
  priorSettleDeductedPaise: number;
}

/**
 * The settle-side payout deduction (in paise, ≥ 0) for one refund.
 *
 * Policy: partners bear the gateway's non-recoverable fee on refunds, and
 * Circls claws back any discount it funded — but eats its own consumer-side
 * commission (the customer is made whole; the partner is not billed for
 * Circls's cut). So a fully-refunded charge must deduct
 * D = amount_paise + platform-funded discount − consumer commission from the
 * partner's payout: for plain and org-funded-coupon sales without a consumer
 * commission that is exactly the customer cash (today's behaviour); for
 * platform-funded-coupon sales it equals the settle credit plus the fee, so
 * the partner nets −fee like any other refunded sale. D ≥ 0 always: the
 * customer total is grossed up on discountedBase + K, so amount ≥ K.
 *
 * Partial refunds prorate D cumulatively: target = floor(totalRefunded·D/A) in
 * BigInt (no float precision loss), and this refund's share is the delta over
 * what earlier refunds already deducted, clamped so the running total never
 * leaves [0, D]. A completed refund therefore deducts exactly D.
 */
export function computeSettleRefundPaise(input: SettleRefundInput): number {
  const deductibleTotal =
    input.chargeAmountPaise + input.platformDiscountPaise - input.consumerCommissionPaise;
  const target = Number(
    (BigInt(input.totalRefundedPaise) * BigInt(deductibleTotal)) /
      BigInt(input.chargeAmountPaise),
  );
  const remaining = deductibleTotal - input.priorSettleDeductedPaise;
  return Math.max(0, Math.min(target - input.priorSettleDeductedPaise, remaining));
}

/**
 * Refunds already made against a charge: the cash refunded so far, and the
 * settle-side deduction those refunds recorded. Refund rows have
 * amount_paise < 0; the absolute value is the already-refunded amount.
 * Anything that isn't 'failed' counts as still owing the money — the provider
 * call has either succeeded or is in flight. settleDeducted uses the same
 * coalesce fallback as the payout refund aggregate, so the cumulative settle
 * math stays consistent across legacy NULL rows.
 *
 * Refunds record their charge in metadata.chargePaymentId; legacy rows that
 * don't count against every charge on the booking (as in payout_service).
 * Without `chargeId` every refund on the booking counts.
 */
export async function sumPriorRefunds(
  exec: Pick<RefundExec, 'select'>,
  bookingId: string,
  chargeId?: string,
): Promise<{ refundedPaise: number; settleDeductedPaise: number }> {
  const [agg] = await exec
    .select({
      refundedSoFar: sql<number>`coalesce(-sum(${payments.amountPaise}), 0)::bigint`,
      settleDeductedSoFar: sql<number>`coalesce(-sum(coalesce(${payments.settleBasePaise}, ${payments.amountPaise})), 0)::bigint`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.bookingId, bookingId),
        eq(payments.kind, 'refund'),
        sql`${payments.status} <> 'failed'`,
        chargeId
          ? sql`coalesce(${payments.metadata}->>'chargePaymentId', ${chargeId}) = ${chargeId}`
          : sql`true`,
      ),
    );
  return {
    refundedPaise: Number(agg?.refundedSoFar ?? 0),
    settleDeductedPaise: Number(agg?.settleDeductedSoFar ?? 0),
  };
}

/**
 * The charge a refund or cancellation on `bookingId` is about: the newest
 * charge that took money (captured / partially refunded), else the newest
 * charge of any status. A booking whose first attempt failed over to another
 * gateway has a dead charge older (or newer) than the one that paid.
 */
export async function selectRefundableCharge(
  exec: Pick<RefundExec, 'select'>,
  bookingId: string,
  lock: boolean,
): Promise<typeof payments.$inferSelect | undefined> {
  const query = exec
    .select()
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.kind, 'charge')))
    .orderBy(
      sql`(${payments.status} in ('captured', 'partially_refunded')) desc`,
      sql`${payments.createdAt} desc`,
    )
    .limit(1);
  const [charge] = lock ? await query.for('update') : await query;
  return charge;
}

/**
 * Our key for a refund, stable across retries of the same refund: the
 * charge plus the refund's sequence number on it. A retry after the gateway
 * accepted a refund but the response was lost rolls this transaction back,
 * so the refund row (and its count) is gone and the retry computes the same
 * key — which the gateway dedupes (see GatewayRefundInput.refundId).
 * Alphanumeric and at most 40 chars for Cashfree's refund_id.
 */
export function refundKey(chargeId: string, sequence: number): string {
  return `r${chargeId.replace(/-/g, '')}n${sequence}`;
}

/**
 * Issue a refund against one charge of `bookingId` (see chargePaymentId).
 *
 * When called inside an enclosing transaction (e.g. by cancellation_service)
 * the caller passes the `tx` so a provider failure rolls the whole
 * cancellation back atomically. When called standalone we open our own
 * transaction.
 */
export async function issueRefund(
  input: IssueRefundInput,
  exec?: RefundExec,
): Promise<IssueRefundResult> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new Conflict('Refund amount must be a positive integer (paise)', 'bad_refund_amount');
  }

  if (exec) return runRefund(exec, input);
  return db.transaction((tx) => runRefund(tx, input));
}

async function runRefund(tx: RefundExec, input: IssueRefundInput): Promise<IssueRefundResult> {
  // 1. Locate the charge row to refund against: the one named, else the
  //    booking's refundable charge (the newest that took money).
  //
  //    M3: take a row lock (SELECT ... FOR UPDATE) on the charge so concurrent
  //    refunds against the same charge serialize. Without it, two refunds can
  //    each read the same `alreadyRefunded` aggregate, both pass the remaining
  //    check, and over-refund. Holding the lock for the whole
  //    read-check-insert (all inside this tx) makes the remaining-amount check
  //    authoritative. Mirrors the FOR UPDATE locking in payout_service.
  let charge: typeof payments.$inferSelect | undefined;
  if (input.chargePaymentId) {
    [charge] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.id, input.chargePaymentId),
          eq(payments.bookingId, input.bookingId),
          eq(payments.kind, 'charge'),
        ),
      )
      .limit(1)
      .for('update');
  } else {
    charge = await selectRefundableCharge(tx, input.bookingId, true);
  }

  if (!charge) throw new NotFound('No charge to refund', 'no_charge_for_booking');

  // 2. Sum any prior refunds against this charge.
  const prior = await sumPriorRefunds(tx, input.bookingId, charge.id);
  const alreadyRefunded = prior.refundedPaise;
  const remaining = Number(charge.amountPaise) - alreadyRefunded;
  if (input.amountPaise > remaining) {
    throw new Conflict(
      `Refund exceeds remaining charge (remaining=${remaining})`,
      'refund_exceeds_charge',
      { remaining, requested: input.amountPaise },
    );
  }
  const totalRefunded = alreadyRefunded + input.amountPaise;

  // 2b. Circls-funded discount on this sale, if any — clawed back from the
  //     partner's payout pro-rata with the refund (see computeSettleRefundPaise).
  const [platformFunded] = await tx
    .select({
      discountPaise: sql<number>`coalesce(sum(${couponRedemptions.discountPaise}), 0)::bigint`,
    })
    .from(couponRedemptions)
    .where(
      and(
        eq(couponRedemptions.bookingId, input.bookingId),
        eq(couponRedemptions.funder, 'platform'),
      ),
    );

  const settleRefundPaise = input.settleNeutral
    ? 0
    : computeSettleRefundPaise({
        chargeAmountPaise: Number(charge.amountPaise),
        platformDiscountPaise: Number(platformFunded?.discountPaise ?? 0),
        consumerCommissionPaise: Number(charge.consumerCommissionPaise ?? 0),
        totalRefundedPaise: totalRefunded,
        priorSettleDeductedPaise: prior.settleDeductedPaise,
      });

  // 2c. This refund's key: its sequence number on the charge. Counted over
  //     every refund row of the charge (failed ones too, so a new attempt
  //     after a rejected refund gets a fresh key).
  const [seq] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(payments)
    .where(
      and(
        eq(payments.bookingId, input.bookingId),
        eq(payments.kind, 'refund'),
        sql`${payments.metadata}->>'chargePaymentId' = ${charge.id}`,
      ),
    );
  const key = refundKey(charge.id, Number(seq?.n ?? 0) + 1);

  // 3. Insert the refund ledger row. Signed amount_paise — negative because
  //    it flows out of the held pot back to the customer. settle_base_paise is
  //    the (negative) payout-side deduction; NULL is reserved for legacy rows.
  const [refundRow] = await tx
    .insert(payments)
    .values({
      bookingId: input.bookingId,
      tenantId: charge.tenantId,
      provider: charge.provider,
      // For external (cash) and stub, no provider id at insert time. For
      // razorpay we backfill after the API call below.
      amountPaise: -input.amountPaise,
      settleBasePaise: -settleRefundPaise,
      currency: charge.currency,
      status: 'pending',
      kind: 'refund',
      metadata: {
        reason: input.reason,
        actorUserId: input.actorUserId,
        chargePaymentId: charge.id,
        refundKey: key,
        ...(input.settleNeutral ? { duplicatePayment: true } : {}),
      },
    })
    .returning();

  if (!refundRow) {
    // Drizzle should never return zero rows from a single-row insert, but the
    // type system can't prove it.
    throw new Error('refund_insert_failed');
  }

  // 4. Gateway call for gateway charges. A gateway charge with neither a
  //    payment id nor an order id can't be refunded at the gateway — refuse
  //    rather than record a refund no money backs.
  //
  // Gateway refund states (`pending`, `processed`, `failed`) map onto our
  // payment_status enum as: processed→captured (money has moved),
  // pending→pending, failed→failed. We keep the wire-level return value
  // separate so the result type still surfaces `'processed'`.
  let providerRefundId: string | undefined;
  let rowStatus: 'pending' | 'captured' | 'failed' = 'captured';
  let resultStatus: 'pending' | 'processed' | 'failed' = 'processed';

  if (isGatewayProvider(charge.provider)) {
    if (!charge.providerPaymentId && !charge.providerOrderId) {
      throw new Conflict('Charge has no gateway payment to refund', 'no_gateway_payment');
    }
    try {
      const res = await getGateway(charge.provider).refundPayment({
        paymentId: charge.providerPaymentId ?? '',
        orderId: charge.providerOrderId,
        refundId: key,
        amountMinor: input.amountPaise,
        reason: input.reason,
        reference: input.bookingId,
      });
      providerRefundId = res.id;
      resultStatus = res.status;
      rowStatus = res.status === 'processed' ? 'captured' : res.status;
    } catch (err) {
      logger.error(
        { err, bookingId: input.bookingId, provider: charge.provider },
        'gateway_refund_failed',
      );
      // Throwing inside the tx rolls everything back — caller's choice via
      // `exec`. The refund row will not be persisted.
      throw err;
    }
  }
  // 'stub' and 'external' providers fall through with rowStatus='captured'.
  // 'external' means cash returned at the counter; the row records the
  // adjustment for accounting.

  // 5. Update the refund row with the provider id (if any) and the final
  //    status.
  await tx
    .update(payments)
    .set({
      status: rowStatus,
      ...(providerRefundId !== undefined ? { providerPaymentId: providerRefundId } : {}),
    })
    .where(eq(payments.id, refundRow.id));

  // 6. Update the original charge's status. Full refund vs partial.
  const newChargeStatus =
    totalRefunded >= Number(charge.amountPaise) ? 'refunded' : 'partially_refunded';
  await tx.update(payments).set({ status: newChargeStatus }).where(eq(payments.id, charge.id));

  // 7. Audit row. tenantId is the charge's tenant — matches the booking's.
  //    System audit: actorUserId may be null for automated refunds.
  await writeSystemAudit(
    tx,
    { tenantId: charge.tenantId, actorUserId: input.actorUserId },
    'payment.refunded',
    'payment',
    refundRow.id,
    null,
    {
      bookingId: input.bookingId,
      chargePaymentId: charge.id,
      amountPaise: input.amountPaise,
      reason: input.reason,
      provider: charge.provider,
      providerRefundId: providerRefundId ?? null,
      status: resultStatus,
      newChargeStatus,
    },
  );

  return {
    paymentId: refundRow.id,
    ...(providerRefundId !== undefined ? { providerRefundId } : {}),
    status: resultStatus,
  };
}
