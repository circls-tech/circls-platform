/**
 * Keeping INR checkouts whole when a gateway (in practice Cashfree) misbehaves:
 *
 *   - verifyCheckoutPayment(): the checkout asks "did my payment go through?"
 *     after the gateway's pop-up closes. For a pending Cashfree charge we ask
 *     Cashfree directly — recording a capture the webhook hasn't delivered yet,
 *     or reporting a declined attempt the customer can retry — so the answer
 *     doesn't depend on webhook timing. (Cashfree's browser SDK can't tell
 *     success from failure, so the checkout must ask us.)
 *   - switchCheckoutGateway(): "Try another way to pay" — retire the
 *     customer's Cashfree order and mint a Razorpay order for the same booking
 *     and amount. If both payments go through, applyPaymentCaptured refunds
 *     the second as a duplicate.
 *   - reconcileCashfreePayments(): scheduled backstop. Cashfree gives up
 *     retrying a webhook after ~40 minutes and its dashboard may not offer
 *     refund webhooks at all, so we poll Cashfree for pending (and recently
 *     failed) charges and pending refunds, and feed what we find into the same
 *     apply* cores the webhooks use.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bookings, payments, userMemberships, type Payment } from '../db/schema/index.js';
import { writeAudit } from '../lib/audit.js';
import { Conflict, NotFound } from '../lib/errors.js';
import {
  getGateway,
  isGatewayProvider,
  publicKeyIdFor,
  type GatewayOrderStatus,
  type PaymentProviderId,
} from '../lib/gateway.js';
import { GatewayHttpError } from '../lib/gateway_http.js';
import { logger } from '../lib/logger.js';
import { applyPaymentCaptured, applyRefundResolution, createPaymentOrder } from './payments_service.js';

/**
 * Where a checkout stands, from the customer's side:
 *   paid        the booking is confirmed.
 *   processing  a payment attempt is still being processed (a UPI request
 *               awaiting approval, say): don't offer a second payment.
 *   pending     not paid, and nothing known to be in flight: no attempt yet,
 *               or the gateway can't be asked.
 *   failed      the latest attempt was declined or abandoned; the same
 *               checkout can be tried again, or moved to another gateway.
 *   expired     it can't be paid any more (the booking was cancelled, or this
 *               order was replaced by one on another gateway).
 */
export type CheckoutPaymentStatus = 'paid' | 'processing' | 'pending' | 'failed' | 'expired';

/**
 * A charge by its gateway order id, only if it belongs to one of `userId`'s
 * bookings. Anything else is a 404 — order ids are unguessable, but a
 * customer must never learn about someone else's payment.
 */
async function loadOwnedCharge(
  userId: string,
  orderId: string,
): Promise<{ charge: Payment; bookingStatus: string }> {
  const [row] = await db
    .select({ charge: payments, bookingStatus: bookings.status, customerUserId: bookings.customerUserId })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .where(and(eq(payments.providerOrderId, orderId), eq(payments.kind, 'charge')))
    .limit(1);
  if (!row || row.customerUserId !== userId) {
    throw new NotFound('Payment not found', 'payment_not_found');
  }
  return { charge: row.charge, bookingStatus: row.bookingStatus };
}

async function bookingStatusOf(bookingId: string): Promise<string | undefined> {
  const [b] = await db
    .select({ status: bookings.status })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1);
  return b?.status;
}

/** Booking statuses that mean the customer's payment went through. */
const PAID_BOOKING = new Set(['confirmed', 'completed', 'no_show']);

/**
 * What our own rows already settle: paid, or no longer payable. Null while
 * the booking and this charge are both still pending.
 */
function settledStatus(
  bookingStatus: string | undefined,
  chargeStatus: string,
): 'paid' | 'expired' | null {
  if (bookingStatus && PAID_BOOKING.has(bookingStatus)) return 'paid';
  if (bookingStatus !== 'pending' || chargeStatus !== 'pending') return 'expired';
  return null;
}

/** Where `charge`'s order stands at its gateway; null if the gateway can't say. */
async function orderAtGateway(
  charge: Payment,
  opts?: { lastAttempt?: boolean },
): Promise<GatewayOrderStatus | null> {
  if (!isGatewayProvider(charge.provider) || !charge.providerOrderId) return null;
  const gateway = getGateway(charge.provider);
  if (gateway.mode !== 'live' || !gateway.fetchOrderStatus) return null;
  return gateway.fetchOrderStatus(charge.providerOrderId, opts);
}

/** Record a payment the gateway reports through the webhook core; true if there was one. */
async function recordCapture(
  charge: Payment,
  order: GatewayOrderStatus,
  eventPrefix: string,
): Promise<boolean> {
  if (order.state !== 'paid' || !order.payment || !charge.providerOrderId) return false;
  if (!isGatewayProvider(charge.provider)) return false;
  await applyPaymentCaptured({
    provider: charge.provider,
    orderId: charge.providerOrderId,
    providerPaymentId: order.payment.id,
    amount: order.payment.amountMinor,
    currency: order.payment.currency,
    eventId: `${eventPrefix}:${order.payment.id}`,
  });
  return true;
}

/** Ask the gateway whether `charge`'s order was paid and, if so, record it. */
async function captureIfPaid(charge: Payment, eventPrefix: string): Promise<boolean> {
  const order = await orderAtGateway(charge);
  return order ? recordCapture(charge, order, eventPrefix) : false;
}

export async function verifyCheckoutPayment(input: {
  userId: string;
  orderId: string;
}): Promise<{ status: CheckoutPaymentStatus }> {
  const { charge, bookingStatus } = await loadOwnedCharge(input.userId, input.orderId);
  const settled = settledStatus(bookingStatus, charge.status);
  if (settled) return { status: settled };
  try {
    const order = await orderAtGateway(charge, { lastAttempt: true });
    if (order && (await recordCapture(charge, order, 'verify'))) {
      const [now] = await db
        .select({ status: payments.status })
        .from(payments)
        .where(eq(payments.id, charge.id))
        .limit(1);
      return {
        status: settledStatus(await bookingStatusOf(charge.bookingId), now?.status ?? charge.status) ?? 'pending',
      };
    }
    if (order?.state === 'closed') return { status: 'expired' };
    if (order?.lastAttempt === 'failed') return { status: 'failed' };
    if (order?.lastAttempt === 'pending') return { status: 'processing' };
  } catch (err) {
    // The gateway can't be asked right now: the customer hears "pending"
    // and the webhook or reconciliation settles it.
    logger.warn({ err, paymentId: charge.id }, 'checkout_payment_verify_failed');
  }
  return { status: 'pending' };
}

export interface SwitchedPayment {
  gateway: PaymentProviderId;
  orderId: string;
  keyId: string;
  clientSecret?: string | undefined;
  amountPaise: number;
  currency: string;
}

export type SwitchGatewayResult =
  | { outcome: 'paid' }
  | { outcome: 'switched'; payment: SwitchedPayment };

/**
 * "Try another way to pay": move a pending Cashfree checkout to Razorpay.
 * Checks Cashfree first: a customer who already paid is told so, and one
 * whose payment is still being processed (a UPI request awaiting approval,
 * say) is asked to wait rather than invited to pay twice. The Razorpay order
 * is created before anything is retired, so if Razorpay fails the Cashfree
 * checkout is left exactly as it was. Terminating the Cashfree order is
 * best-effort (Cashfree may be the thing that's down); if both payments land,
 * the second is refunded as a duplicate (applyPaymentCaptured).
 */
export async function switchCheckoutGateway(input: {
  userId: string;
  orderId: string;
}): Promise<SwitchGatewayResult> {
  const { charge, bookingStatus } = await loadOwnedCharge(input.userId, input.orderId);
  if (bookingStatus && PAID_BOOKING.has(bookingStatus)) return { outcome: 'paid' };
  if (charge.provider !== 'cashfree') {
    throw new Conflict('This checkout cannot switch payment method', 'gateway_switch_unavailable');
  }
  if (bookingStatus !== 'pending' || charge.status !== 'pending') {
    throw new Conflict('This checkout has expired — please book again', 'checkout_expired');
  }

  let atCashfree: GatewayOrderStatus | null = null;
  try {
    atCashfree = await orderAtGateway(charge, { lastAttempt: true });
    if (atCashfree && (await recordCapture(charge, atCashfree, 'switch'))) return { outcome: 'paid' };
  } catch (err) {
    // Cashfree being unreachable is exactly why the customer is switching.
    logger.warn({ err, paymentId: charge.id }, 'gateway_switch_status_check_failed');
  }
  if (atCashfree?.state === 'open' && atCashfree.lastAttempt === 'pending') {
    throw new Conflict(
      'Your payment is still being processed — wait for it to finish before paying another way',
      'payment_in_progress',
    );
  }

  // Same money, same snapshots, new gateway — created first, so that if
  // Razorpay fails nothing has been retired and the customer can retry.
  const billing = charge.metadata['billing'] as Record<string, number> | undefined;
  const order = await createPaymentOrder({
    bookingId: charge.bookingId,
    tenantId: charge.tenantId,
    amountPaise: Number(charge.amountPaise),
    ...(charge.settleBasePaise !== null ? { settleBasePaise: Number(charge.settleBasePaise) } : {}),
    ...(charge.consumerCommissionPaise !== null
      ? { consumerCommissionPaise: Number(charge.consumerCommissionPaise) }
      : {}),
    ...(charge.partnerCommissionPaise !== null
      ? { partnerCommissionPaise: Number(charge.partnerCommissionPaise) }
      : {}),
    ...(charge.advancePaise !== null ? { advancePaise: Number(charge.advancePaise) } : {}),
    ...(billing ? { billingMetadata: billing } : {}),
    provider: 'razorpay',
    currency: charge.currency,
    actorUserId: input.userId,
  });

  // Retire the Cashfree charge. Status-guarded: a capture that landed in the
  // meantime wins, the new Razorpay charge is retired instead, and the
  // customer is told they've paid.
  const [retired] = await db
    .update(payments)
    .set({
      status: 'failed',
      metadata: sql`${payments.metadata} || ${JSON.stringify({ switchedTo: 'razorpay' })}::jsonb`,
    })
    .where(and(eq(payments.id, charge.id), eq(payments.status, 'pending')))
    .returning({ id: payments.id });
  if (!retired) {
    await db
      .update(payments)
      .set({ status: 'failed' })
      .where(and(eq(payments.id, order.paymentId), eq(payments.status, 'pending')));
    const now = await bookingStatusOf(charge.bookingId);
    if (now && PAID_BOOKING.has(now)) return { outcome: 'paid' };
    throw new Conflict('This checkout has expired — please book again', 'checkout_expired');
  }

  const cashfree = getGateway('cashfree');
  if (cashfree.mode === 'live') {
    try {
      await cashfree.cancelOrder(input.orderId);
    } catch (err) {
      logger.warn({ err, paymentId: charge.id }, 'gateway_switch_cancel_failed');
    }
  }

  // A membership purchase points at its charge; follow the switch.
  await db
    .update(userMemberships)
    .set({ paymentId: order.paymentId })
    .where(eq(userMemberships.paymentId, charge.id));

  await writeAudit(
    db,
    { tenantId: charge.tenantId, actorUserId: input.userId },
    'payment.gateway_switched',
    'payment',
    charge.id,
    { provider: 'cashfree', providerOrderId: input.orderId },
    { provider: order.provider, paymentId: order.paymentId, providerOrderId: order.providerOrderId },
  );

  return {
    outcome: 'switched',
    payment: {
      gateway: order.provider,
      orderId: order.providerOrderId,
      keyId: publicKeyIdFor(order.provider),
      ...(order.clientSecret !== undefined ? { clientSecret: order.clientSecret } : {}),
      amountPaise: Number(charge.amountPaise),
      currency: charge.currency,
    },
  };
}

/** Rows checked per run; the job runs every few minutes. */
const RECONCILE_BATCH = 50;

/**
 * Poll Cashfree for what its webhooks may not have told us:
 *   - charges still pending a few minutes after their order was created
 *     (confirm the booking), and charges failed in the last two days (a late
 *     payment on a swept or switched order — applyPaymentCaptured records it
 *     and refunds it, since that booking is cancelled or already paid);
 *   - refunds still pending (Cashfree may send no refund webhooks).
 * Pending charges come first: they're the ones a lost webhook costs a
 * customer their booking over, once the abandoned-cart sweep cancels it.
 * Failed charges and refunds are re-checked at most every 30 minutes, least
 * recently checked first; a row whose check fails is pushed back too, so it
 * can't hold the head of every run. Stops early when Cashfree is down; the
 * next run carries on.
 */
export async function reconcileCashfreePayments(): Promise<{ captured: number; refundsResolved: number }> {
  const gateway = getGateway('cashfree');
  const result = { captured: 0, refundsResolved: 0 };
  if (gateway.mode !== 'live' || !gateway.fetchOrderStatus || !gateway.fetchRefundStatus) {
    return result;
  }

  const recheckDue = sql`coalesce((${payments.metadata}->>'reconciledAt')::timestamptz, 'epoch') < now() - interval '30 minutes'`;
  const leastRecentlyChecked = sql`coalesce((${payments.metadata}->>'reconciledAt')::timestamptz, ${payments.createdAt})`;
  // Merged in SQL, not rewritten from our copy, so keys other writers add
  // to the row meanwhile survive.
  const stamp = (row: Payment) =>
    db
      .update(payments)
      .set({
        metadata: sql`${payments.metadata} || ${JSON.stringify({ reconciledAt: new Date().toISOString() })}::jsonb`,
      })
      .where(eq(payments.id, row.id))
      .catch((err: unknown) => logger.error({ err, paymentId: row.id }, 'cashfree_reconcile_stamp_failed'));

  const recentCharge = and(
    eq(payments.provider, 'cashfree'),
    eq(payments.kind, 'charge'),
    isNotNull(payments.providerOrderId),
    sql`${payments.createdAt} > now() - interval '48 hours'`,
  );
  // Oldest first: the closest to being swept.
  const pending = await db
    .select()
    .from(payments)
    .where(
      and(
        recentCharge,
        eq(payments.status, 'pending'),
        sql`${payments.createdAt} < now() - interval '3 minutes'`,
      ),
    )
    .orderBy(payments.createdAt)
    .limit(RECONCILE_BATCH);
  const failed =
    pending.length < RECONCILE_BATCH
      ? await db
          .select()
          .from(payments)
          .where(and(recentCharge, eq(payments.status, 'failed'), recheckDue))
          .orderBy(leastRecentlyChecked)
          .limit(RECONCILE_BATCH - pending.length)
      : [];

  for (const charge of [...pending, ...failed]) {
    try {
      if (await captureIfPaid(charge, 'reconcile')) {
        result.captured++;
        logger.warn({ paymentId: charge.id, status: charge.status }, 'cashfree_reconcile_captured');
      } else if (charge.status === 'failed') {
        await stamp(charge);
      }
    } catch (err) {
      logger.error({ err, paymentId: charge.id }, 'cashfree_reconcile_charge_failed');
      if (err instanceof GatewayHttpError && err.outage) return result;
      if (charge.status === 'failed') await stamp(charge);
    }
  }

  const refunds = await db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.provider, 'cashfree'),
        eq(payments.kind, 'refund'),
        eq(payments.status, 'pending'),
        isNotNull(payments.providerPaymentId),
        sql`${payments.createdAt} < now() - interval '5 minutes'`,
        sql`${payments.createdAt} > now() - interval '30 days'`,
        recheckDue,
      ),
    )
    .orderBy(leastRecentlyChecked)
    .limit(RECONCILE_BATCH);

  for (const refund of refunds) {
    try {
      const chargeId = refund.metadata['chargePaymentId'];
      const [charge] = typeof chargeId === 'string'
        ? await db
            .select({ orderId: payments.providerOrderId })
            .from(payments)
            .where(eq(payments.id, chargeId))
            .limit(1)
        : [];
      if (!charge?.orderId) {
        await stamp(refund);
        continue;
      }
      // Refunds made before refund keys existed used the row id as refund_id.
      const key =
        typeof refund.metadata['refundKey'] === 'string' ? refund.metadata['refundKey'] : refund.id;
      const status = await gateway.fetchRefundStatus({ orderId: charge.orderId, refundId: key });
      if (status.status === 'pending') {
        await stamp(refund);
        continue;
      }
      await applyRefundResolution({
        provider: 'cashfree',
        refundId: refund.providerPaymentId!,
        targetStatus: status.status === 'processed' ? 'captured' : 'failed',
        eventId: `reconcile:${refund.providerPaymentId}:${status.status}`,
      });
      result.refundsResolved++;
    } catch (err) {
      logger.error({ err, paymentId: refund.id }, 'cashfree_reconcile_refund_failed');
      if (err instanceof GatewayHttpError && err.outage) return result;
      await stamp(refund);
    }
  }
  return result;
}
