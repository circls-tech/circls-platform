/**
 * One definition of "is this money ever going to reach the partner?"
 *
 * A charge only reaches a partner's payout once it has a settlement hold (or
 * has already been released). A payment that succeeds *after* its booking was
 * cancelled — a late UPI success, say — is refunded automatically and never
 * held, so its gross never enters a payout. Deducting its refund anyway
 * charges the partner for a sale they never had. Saur Grapes lost ₹614.17 to
 * exactly that in the week of 17 Aug.
 *
 * Every read model that nets refunds against partner money MUST filter on
 * this, or it will disagree with the payout it claims to explain. It lives in
 * its own module so the reconciler, the payout breakdown and the partner-facing
 * earnings figures cannot drift apart.
 *
 * The refund row names its charge in `metadata.chargePaymentId`; rows written
 * before that was stamped fall back to any charge on the same booking.
 */
import { sql, type SQL } from 'drizzle-orm';

/**
 * True when a CHARGE row is on its way to the partner: it has a settlement
 * hold, or has already been released.
 *
 * Payout reconciliation gets this for free by windowing on
 * `settlement_released_at`. Anything that windows on `created_at` instead — to
 * lead the payout rather than mirror it — has to say so explicitly, or it will
 * credit the partner for a charge that will never settle.
 *
 * @param chargeAlias The charge row's table alias in the enclosing statement.
 */
export function settleableCharge(chargeAlias = 'p'): SQL {
  const c = sql.raw(chargeAlias);
  return sql`(${c}.settlement_hold_until is not null or ${c}.settlement_released_at is not null)`;
}

/**
 * True when a REFUND row is against a charge that was going to reach the
 * partner — the counterpart of {@link settleableCharge}, applied to the charge
 * the refund names. Use both together: deducting a refund whose charge was
 * never counted, or counting a charge whose refund is then skipped, are the two
 * halves of the same mistake.
 *
 * @param refundAlias The refund row's table alias in the enclosing statement —
 *   `'p'` for a query that aliases `payments p`, `'payments'` for one that
 *   doesn't alias it at all (which is how Drizzle renders its columns).
 */
export function creditableCharge(refundAlias = 'p'): SQL {
  const r = sql.raw(refundAlias);
  return sql`exists (
    select 1 from payments ch
     where ch.kind = 'charge'
       and ch.booking_id = ${r}.booking_id
       and (${r}.metadata->>'chargePaymentId' is null
            or ch.id::text = ${r}.metadata->>'chargePaymentId')
       and (ch.settlement_hold_until is not null or ch.settlement_released_at is not null)
  )`;
}

/**
 * True when a payment's money has ALREADY been transferred to the partner —
 * it falls inside a payout this tenant has been marked paid for.
 *
 * The counterpart to the two predicates above: they answer "will this money
 * reach the partner?", this one answers "has it?". Attribution mirrors
 * `reconcileWeeklyPayouts` exactly, because a payout's contents are not stored
 * per payment and can only be re-derived: a CHARGE belongs to the week
 * containing its `settlement_released_at`, a REFUND to the week containing its
 * `created_at`. Get that wrong and this reports money as paid that a payout
 * never carried.
 *
 * Only `status = 'paid'` counts. A reconciled-but-pending payout is money
 * promised, not money sent, and a partner reading "paid out" would reasonably
 * expect it to be in their bank.
 *
 * Covers the SETTLEMENT tranche only; {@link advancePaidOut} covers the other
 * one. The two are separate because a charge can have had one and not the
 * other.
 *
 * A charge still under hold has a NULL `settlement_released_at` and so matches
 * nothing — correct, since no payout can have carried it yet.
 *
 * @param alias The payment row's table alias in the enclosing statement.
 */
export function paidOutPayment(alias = 'p'): SQL {
  const p = sql.raw(alias);
  return sql`exists (
    select 1 from payouts po
     where po.tenant_id = ${p}.tenant_id
       and po.currency  = ${p}.currency
       and po.status    = 'paid'
       and po.period_start is not null
       and po.period_end   is not null
       and (case when ${p}.kind = 'charge'
                 then ${p}.settlement_released_at
                 else ${p}.created_at end) >= po.period_start
       and (case when ${p}.kind = 'charge'
                 then ${p}.settlement_released_at
                 else ${p}.created_at end) <  po.period_end
  )`;
}

/**
 * True when this charge's ADVANCE tranche has already been transferred.
 *
 * An advance is money Circls fronts against a sale before its settlement hold
 * expires. `reconcileWeeklyPayouts` adds it to the payout for the week
 * containing `advance_released_at`, then deducts it again from the week the
 * charge actually settles — so across both weeks it nets out, and it changes
 * only WHEN the partner is paid, not how much.
 *
 * That timing is exactly what a "how much has reached me?" figure has to
 * respect. Without it, a charge reads as entirely unpaid right up until its
 * settlement week is paid, even though part of its money has already gone out.
 * Reconciliation builds a payout from three tranches — charges by
 * `settlement_released_at`, advances by `advance_released_at`, refunds by
 * `created_at` — and a figure claiming to mirror it has to account for all
 * three.
 *
 * @param alias The payment row's table alias in the enclosing statement.
 */
export function advancePaidOut(alias = 'p'): SQL {
  const p = sql.raw(alias);
  return sql`(${p}.advance_released_at is not null and exists (
    select 1 from payouts po
     where po.tenant_id = ${p}.tenant_id
       and po.currency  = ${p}.currency
       and po.status    = 'paid'
       and po.period_start is not null
       and po.period_end   is not null
       and ${p}.advance_released_at >= po.period_start
       and ${p}.advance_released_at <  po.period_end
  ))`;
}
