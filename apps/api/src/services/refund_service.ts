/**
 * Refund service — Phase 14.
 *
 * Refund engine branches by provider:
 *   - razorpay  → call getRazorpay().refundPayment(); persist provider id.
 *   - stub      → no provider call; status='processed' instantly.
 *   - external  → no provider call; cash refund handled offline at the venue.
 *
 * Weekly payout reconciliation lives in `payout_service.ts`.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { payments } from '../db/schema/payments.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';
import { getRazorpay } from '../lib/razorpay.js';
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
  actorUserId: string;
}

export interface IssueRefundResult {
  paymentId: string;
  providerRefundId?: string;
  status: 'pending' | 'processed' | 'failed';
}

/**
 * Issue a refund against the most-recent charge for `bookingId`.
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
  // 1. Locate the charge row to refund against. Use the most recent captured
  //    charge for this booking. (Multiple charges per booking are not yet a
  //    real path, but we sort by created_at desc to be future-proof.)
  //
  //    M3: take a row lock (SELECT ... FOR UPDATE) on the charge so concurrent
  //    refunds against the same charge serialize. Without it, two refunds can
  //    each read the same `alreadyRefunded` aggregate, both pass the remaining
  //    check, and over-refund. Holding the lock for the whole
  //    read-check-insert (all inside this tx) makes the remaining-amount check
  //    authoritative. Mirrors the FOR UPDATE locking in payout_service.
  const [charge] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.bookingId, input.bookingId), eq(payments.kind, 'charge')))
    .orderBy(sql`${payments.createdAt} desc`)
    .limit(1)
    .for('update');

  if (!charge) throw new NotFound('No charge to refund', 'no_charge_for_booking');

  // 2. Sum any prior refunds against this charge. Refund rows have
  //    amount_paise < 0; the absolute value is the already-refunded amount.
  //    Anything that isn't 'failed' counts as still owing the money — the
  //    provider call has either succeeded or is in flight.
  const [refundedAgg] = await tx
    .select({
      refundedSoFar: sql<number>`coalesce(-sum(${payments.amountPaise}), 0)::bigint`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.bookingId, input.bookingId),
        eq(payments.kind, 'refund'),
        sql`${payments.status} <> 'failed'`,
      ),
    );

  const alreadyRefunded = Number(refundedAgg?.refundedSoFar ?? 0);
  const remaining = Number(charge.amountPaise) - alreadyRefunded;
  if (input.amountPaise > remaining) {
    throw new Conflict(
      `Refund exceeds remaining charge (remaining=${remaining})`,
      'refund_exceeds_charge',
      { remaining, requested: input.amountPaise },
    );
  }

  // 3. Insert the refund ledger row. Signed amount_paise — negative because
  //    it flows out of the held pot back to the customer.
  const [refundRow] = await tx
    .insert(payments)
    .values({
      bookingId: input.bookingId,
      tenantId: charge.tenantId,
      provider: charge.provider,
      // For external (cash) and stub, no provider id at insert time. For
      // razorpay we backfill after the API call below.
      amountPaise: -input.amountPaise,
      currency: charge.currency,
      status: 'pending',
      kind: 'refund',
      metadata: {
        reason: input.reason,
        actorUserId: input.actorUserId,
        chargePaymentId: charge.id,
      },
    })
    .returning();

  if (!refundRow) {
    // Drizzle should never return zero rows from a single-row insert, but the
    // type system can't prove it.
    throw new Error('refund_insert_failed');
  }

  // 4. Provider call (only for razorpay charges that have a provider payment id).
  //
  // Razorpay's refund states (`pending`, `processed`, `failed`) map onto our
  // payment_status enum as: processed→captured (money has moved),
  // pending→pending, failed→failed. We keep the wire-level return value
  // separate so the result type still surfaces `'processed'`.
  let providerRefundId: string | undefined;
  let rowStatus: 'pending' | 'captured' | 'failed' = 'captured';
  let resultStatus: 'pending' | 'processed' | 'failed' = 'processed';

  if (charge.provider === 'razorpay' && charge.providerPaymentId) {
    try {
      const res = await getRazorpay().refundPayment({
        paymentId: charge.providerPaymentId,
        amountPaise: input.amountPaise,
        reason: input.reason,
        reference: input.bookingId,
      });
      providerRefundId = res.id;
      resultStatus = res.status;
      rowStatus = res.status === 'processed' ? 'captured' : res.status;
    } catch (err) {
      logger.error({ err, bookingId: input.bookingId }, 'razorpay_refund_failed');
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
  const totalRefunded = alreadyRefunded + input.amountPaise;
  const newChargeStatus =
    totalRefunded >= Number(charge.amountPaise) ? 'refunded' : 'partially_refunded';
  await tx.update(payments).set({ status: newChargeStatus }).where(eq(payments.id, charge.id));

  // 7. Audit row. tenantId is the charge's tenant — matches the booking's.
  await writeAudit(
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
