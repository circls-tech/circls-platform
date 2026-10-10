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
