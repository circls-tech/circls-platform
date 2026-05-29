/**
 * Payments service — Phase 12 (Track B). Owns the writes against the
 * `payments` table plus the Razorpay webhook handler.
 *
 * Contract surfaces (consumed by routes + booking flow):
 *   - createRouteOrder(): called by booking_service.prepareOnlineBookingWithPayment
 *     when paymentMethod='razorpay_route'. Inserts a `pending` charge row, calls
 *     Razorpay to create the Route order, and persists the provider_order_id.
 *   - handleRazorpayWebhook(): called by POST /webhooks/razorpay (signature
 *     verified upstream). Idempotent on the event id — replays are no-ops.
 *   - listForBooking() / getPayment(): read endpoints used by partner + admin UIs.
 *
 * Webhook idempotency strategy: we look up the payments row by
 * `provider_order_id` and short-circuit if it's already in the destination
 * state (status='captured' for `payment.captured`, status='failed' for
 * `payment.failed`). That makes Razorpay's at-least-once retries safe without
 * a separate processed-events table.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Booking, bookings, payments, type Payment } from '../db/schema/index.js';
import { writeAudit, type AuditCtx } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { getRazorpay } from '../lib/razorpay.js';
import { notifyBookingConfirmed } from './notification_service.js';
import { holdForBooking } from './settlement_hold_service.js';

export interface CreateRouteOrderInput {
  bookingId: string;
  tenantId: string;
  amountPaise: number;
  /** Razorpay Linked Account on the tenant. */
  linkedAccountId: string;
  /** Platform commission in paise. */
  platformFeePaise: number;
  /** Audit actor — usually the customer (or the admin impersonating them). */
  actorUserId: string;
}

export interface CreateRouteOrderResult {
  paymentId: string;
  providerOrderId: string;
}

/**
 * Two-step write: insert a `pending` charge row first so we have a paymentId to
 * audit even if Razorpay's create-order call later fails; then call Razorpay
 * and patch the row with the returned order id. The stub adapter never throws,
 * but the live adapter will when creds are missing — the pending row stays as
 * a forensic breadcrumb.
 */
export async function createRouteOrder(
  input: CreateRouteOrderInput,
): Promise<CreateRouteOrderResult> {
  const adapter = getRazorpay();
  const provider = adapter.mode === 'stub' ? 'stub' : 'razorpay';

  const [row] = await db
    .insert(payments)
    .values({
      bookingId: input.bookingId,
      tenantId: input.tenantId,
      provider,
      amountPaise: input.amountPaise,
      currency: 'INR',
      status: 'pending',
      kind: 'charge',
      metadata: {
        linkedAccountId: input.linkedAccountId,
        platformFeePaise: input.platformFeePaise,
      },
    })
    .returning();
  if (!row) throw new Error('payments insert returned no row');

  const order = await adapter.createRouteOrder({
    amountPaise: input.amountPaise,
    currency: 'INR',
    linkedAccountId: input.linkedAccountId,
    platformFeePaise: input.platformFeePaise,
    reference: input.bookingId,
  });

  await db
    .update(payments)
    .set({ providerOrderId: order.id })
    .where(eq(payments.id, row.id));

  const ctx: AuditCtx = { tenantId: input.tenantId, actorUserId: input.actorUserId };
  await writeAudit(db, ctx, 'payment.order_created', 'payment', row.id, null, {
    bookingId: input.bookingId,
    amountPaise: input.amountPaise,
    provider,
    providerOrderId: order.id,
  });

  return { paymentId: row.id, providerOrderId: order.id };
}

export interface WebhookEvent {
  event: string;
  payload: Record<string, unknown>;
  /** Idempotency key from the webhook header (Razorpay's `x-razorpay-event-id`). */
  eventId: string;
}

/**
 * Pull the payment entity (the entity inside `payload.payment.entity`) out of
 * Razorpay's nested webhook envelope without dragging a full type model in.
 */
function extractPaymentEntity(
  payload: Record<string, unknown>,
): { order_id?: string; id?: string; status?: string } | undefined {
  const paymentWrap = payload['payment'];
  if (!paymentWrap || typeof paymentWrap !== 'object') return undefined;
  const entity = (paymentWrap as Record<string, unknown>)['entity'];
  if (!entity || typeof entity !== 'object') return undefined;
  return entity as { order_id?: string; id?: string; status?: string };
}

function extractRefundEntity(
  payload: Record<string, unknown>,
): { id?: string; payment_id?: string; amount?: number; status?: string } | undefined {
  const refundWrap = payload['refund'];
  if (!refundWrap || typeof refundWrap !== 'object') return undefined;
  const entity = (refundWrap as Record<string, unknown>)['entity'];
  if (!entity || typeof entity !== 'object') return undefined;
  return entity as { id?: string; payment_id?: string; amount?: number; status?: string };
}

/**
 * Razorpay webhook fan-out. Wraps the per-event work in a single transaction so
 * the payments + bookings + audit rows are mutually consistent. Idempotency is
 * achieved by checking the current row state before mutating — re-deliveries
 * find the row already in the destination state and short-circuit.
 *
 * Phase 14 owns the refund branch beyond a stub; we record the event_id in the
 * audit log so reconciliation has a trail.
 */
export async function handleRazorpayWebhook(event: WebhookEvent): Promise<void> {
  switch (event.event) {
    case 'payment.captured':
      await handlePaymentCaptured(event);
      return;
    case 'payment.failed':
      await handlePaymentFailed(event);
      return;
    case 'refund.processed':
      await handleRefundProcessedStub(event);
      return;
    default:
      // Unknown events: log and ack so Razorpay doesn't retry forever.
      logger.info({ event: event.event, eventId: event.eventId }, 'razorpay_webhook_ignored');
      return;
  }
}

async function handlePaymentCaptured(event: WebhookEvent): Promise<void> {
  const entity = extractPaymentEntity(event.payload);
  if (!entity?.order_id) {
    logger.warn({ eventId: event.eventId }, 'razorpay_webhook_missing_order_id');
    return;
  }
  const orderId = entity.order_id;
  const providerPaymentId = entity.id;

  await db.transaction(async (tx) => {
    const [pay] = await tx
      .select()
      .from(payments)
      .where(eq(payments.providerOrderId, orderId))
      .limit(1);

    if (!pay) {
      // No payments row for this order id — log and ack. Could happen if we
      // missed the createRouteOrder write but Razorpay still saw the payment.
      logger.warn({ orderId, eventId: event.eventId }, 'razorpay_capture_unknown_order');
      return;
    }

    // Idempotency: replays of the same event find the row already captured.
    if (pay.status === 'captured') {
      logger.info({ paymentId: pay.id, eventId: event.eventId }, 'razorpay_capture_replay_ignored');
      return;
    }

    // Flip the row to captured first so holdForBooking() (which filters on
    // status='captured') can find it inside the same transaction.
    await tx
      .update(payments)
      .set({
        status: 'captured',
        providerPaymentId: providerPaymentId ?? pay.providerPaymentId,
      })
      .where(eq(payments.id, pay.id));

    // Compute settlement_hold_until from the booking's slot end.
    await holdForBooking(pay.bookingId, tx);

    // Confirm the booking now that funds are captured.
    const [booking] = await tx
      .update(bookings)
      .set({ status: 'confirmed' })
      .where(eq(bookings.id, pay.bookingId))
      .returning();

    // System-driven audit row: webhook handler has no human actor. Raw insert
    // since writeAudit() requires an actorUserId we don't have.
    await tx.execute(sql`
      insert into audit_log (tenant_id, action, entity_type, entity_id, before, after)
      values (
        ${pay.tenantId}::uuid,
        'payment.captured',
        'payment',
        ${pay.id}::uuid,
        ${JSON.stringify({ status: pay.status })}::jsonb,
        ${JSON.stringify({ status: 'captured', eventId: event.eventId, providerPaymentId: providerPaymentId ?? null })}::jsonb
      )
    `);

    if (booking) {
      // Phase 13 wires the actual SMS/email; today this is a no-op stub.
      await notifyBookingConfirmed(booking.id);
    }
  });
}

async function handlePaymentFailed(event: WebhookEvent): Promise<void> {
  const entity = extractPaymentEntity(event.payload);
  if (!entity?.order_id) {
    logger.warn({ eventId: event.eventId }, 'razorpay_webhook_missing_order_id');
    return;
  }
  const orderId = entity.order_id;

  await db.transaction(async (tx) => {
    const [pay] = await tx
      .select()
      .from(payments)
      .where(eq(payments.providerOrderId, orderId))
      .limit(1);

    if (!pay) {
      logger.warn({ orderId, eventId: event.eventId }, 'razorpay_failed_unknown_order');
      return;
    }

    // Idempotency: already-failed rows are a no-op replay.
    if (pay.status === 'failed') {
      logger.info({ paymentId: pay.id, eventId: event.eventId }, 'razorpay_failed_replay_ignored');
      return;
    }

    await tx
      .update(payments)
      .set({ status: 'failed' })
      .where(eq(payments.id, pay.id));

    // Cancel the (still pending) booking so the slot frees up.
    const [booking] = await tx
      .update(bookings)
      .set({ status: 'cancelled' })
      .where(and(eq(bookings.id, pay.bookingId), eq(bookings.status, 'pending')))
      .returning();

    if (booking) {
      // Mirror cancelBooking()'s slot release.
      await tx.execute(sql`
        update slots set status = 'open', booking_id = null, hold_expires_at = null, held_by_user_id = null
        where booking_id = ${booking.id} and deleted_at is null
      `);
    }

    await tx.execute(sql`
      insert into audit_log (tenant_id, action, entity_type, entity_id, before, after)
      values (
        ${pay.tenantId}::uuid,
        'payment.failed',
        'payment',
        ${pay.id}::uuid,
        ${JSON.stringify({ status: pay.status })}::jsonb,
        ${JSON.stringify({ status: 'failed', eventId: event.eventId })}::jsonb
      )
    `);
  });
}

/**
 * Refund webhook stub. Phase 14 (refund_service) owns the matching write —
 * a refund row is inserted when the API triggers the refund, and this handler
 * is what flips it to `processed`. For Phase 12 we log an audit breadcrumb so
 * reconciliation can see the event arrived.
 */
async function handleRefundProcessedStub(event: WebhookEvent): Promise<void> {
  // TODO(phase-14): match the refund entity by provider_payment_id and update
  // the refund row's status to 'processed'. This sits in refund_service.
  const entity = extractRefundEntity(event.payload);
  logger.info(
    { eventId: event.eventId, refundId: entity?.id, paymentId: entity?.payment_id },
    'razorpay_refund_processed_stub',
  );
}

export async function listForBooking(bookingId: string): Promise<Payment[]> {
  return db.select().from(payments).where(eq(payments.bookingId, bookingId));
}

export async function getPayment(
  paymentId: string,
  tenantId: string,
): Promise<Payment | null> {
  const [row] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

// Re-export so callers can find the booking helper alongside payment helpers
// without cycling imports.
export type { Booking };
export { holdForBooking };
