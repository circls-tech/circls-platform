/**
 * Payments service — Phase 12 (Track B). Owns the writes against the
 * `payments` table plus the Razorpay webhook handler.
 *
 * Contract surfaces (consumed by routes + booking flow):
 *   - createPaymentOrder(): called by booking_service.prepareOnlineBookingWithPayment
 *     when paymentMethod='razorpay_route'. Inserts a `pending` charge row, asks
 *     the payment gateway to create the order, and persists the provider_order_id.
 *   - handleRazorpayWebhook() / handleStripeWebhook(): called by the
 *     /webhooks/* routes (signature verified upstream). Both extract their
 *     provider's envelope and delegate to shared apply* cores, so idempotency
 *     and state transitions behave identically per gateway.
 *   - resolvePaymentContext(): which gateway/currency a booking charges
 *     through, from the venue's (fallback: tenant's) country.
 *   - listForBooking() / getPayment(): read endpoints used by partner + admin UIs.
 *
 * Webhook idempotency strategy: we look up the payments row by
 * `provider_order_id` and short-circuit if it's already in the destination
 * state (status='captured' for a capture, status='failed' for a failure).
 * That makes at-least-once retries safe without a separate processed-events
 * table.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type Booking, bookings, payments, tenants, venues, type Payment } from '../db/schema/index.js';
import { writeAudit, type AuditCtx } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import {
  currencyForCountry,
  getGateway,
  providerForCountry,
  type PaymentProviderId,
} from '../lib/gateway.js';
import { notifyBookingConfirmed } from './notification_service.js';
import { issueQrTicketsForBooking } from './qr_ticket_service.js';
import { holdForBooking } from './settlement_hold_service.js';

export interface PaymentContext {
  provider: PaymentProviderId;
  currency: string;
}

/**
 * Resolve which gateway settles a booking's money: the venue's country when
 * there is one, else the owning tenant's. Everything non-US (including a
 * missing country) charges INR via Razorpay — the pre-multi-gateway default.
 */
export async function resolvePaymentContext(
  opts: { venueId?: string | null | undefined; tenantId: string },
  exec: Pick<typeof db, 'select'> = db,
): Promise<PaymentContext> {
  let country: string | null = null;
  if (opts.venueId) {
    const [v] = await exec
      .select({ country: venues.country })
      .from(venues)
      .where(eq(venues.id, opts.venueId))
      .limit(1);
    country = v?.country ?? null;
  }
  if (!country) {
    const [t] = await exec
      .select({ country: tenants.country })
      .from(tenants)
      .where(eq(tenants.id, opts.tenantId))
      .limit(1);
    country = t?.country ?? null;
  }
  return { provider: providerForCountry(country), currency: currencyForCountry(country) };
}

export interface CreatePaymentOrderInput {
  bookingId: string;
  tenantId: string;
  /** Charge total in the currency's minor unit (paise for INR). */
  amountPaise: number;
  /**
   * Org-settleable base for this charge (gross-up excluded; full base when
   * platform-funded). The weekly payout reconciliation sums this for gross.
   * Defaults to amountPaise when omitted (legacy callers / no-gross-up path).
   */
  settleBasePaise?: number;
  /**
   * Gateway to charge through. Callers will resolve this from the venue's
   * country (`providerForCountry`) once Stripe ships; today everything is
   * Razorpay.
   */
  provider?: PaymentProviderId;
  /** ISO 4217. Defaults to INR. */
  currency?: string;
  /** Audit actor — usually the customer (or the admin impersonating them). */
  actorUserId: string;
}

export interface CreatePaymentOrderResult {
  paymentId: string;
  providerOrderId: string;
  /** Stripe only: what the browser needs to confirm the PaymentIntent. */
  clientSecret?: string | undefined;
}

/**
 * Two-step write: insert a `pending` charge row first so we have a paymentId to
 * audit even if the gateway's create-order call later fails; then call the
 * gateway and patch the row with the returned order id. The stub adapter never
 * throws, but a live adapter will when creds are missing — the pending row
 * stays as a forensic breadcrumb.
 */
export async function createPaymentOrder(
  input: CreatePaymentOrderInput,
): Promise<CreatePaymentOrderResult> {
  const gateway = getGateway(input.provider ?? 'razorpay');
  const provider = gateway.mode === 'stub' ? 'stub' : gateway.provider;
  const currency = input.currency ?? 'INR';

  const [row] = await db
    .insert(payments)
    .values({
      bookingId: input.bookingId,
      tenantId: input.tenantId,
      provider,
      amountPaise: input.amountPaise,
      settleBasePaise: input.settleBasePaise ?? input.amountPaise,
      currency,
      status: 'pending',
      kind: 'charge',
      metadata: {},
    })
    .returning();
  if (!row) throw new Error('payments insert returned no row');

  const order = await gateway.createOrder({
    amountMinor: input.amountPaise,
    currency,
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

  return {
    paymentId: row.id,
    providerOrderId: order.id,
    ...(order.clientSecret !== undefined ? { clientSecret: order.clientSecret } : {}),
  };
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
): { order_id?: string; id?: string; status?: string; amount?: number; currency?: string } | undefined {
  const paymentWrap = payload['payment'];
  if (!paymentWrap || typeof paymentWrap !== 'object') return undefined;
  const entity = (paymentWrap as Record<string, unknown>)['entity'];
  if (!entity || typeof entity !== 'object') return undefined;
  return entity as { order_id?: string; id?: string; status?: string; amount?: number; currency?: string };
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
 * Razorpay webhook fan-out. Extracts Razorpay's envelope and delegates to the
 * shared apply* cores below. Each core wraps its work in a single transaction
 * so the payments + bookings + audit rows are mutually consistent; idempotency
 * is achieved by checking the current row state before mutating —
 * re-deliveries find the row already in the destination state and
 * short-circuit.
 *
 * Phase 14 owns the refund branch beyond a stub; we record the event_id in the
 * audit log so reconciliation has a trail.
 */
export async function handleRazorpayWebhook(event: WebhookEvent): Promise<void> {
  switch (event.event) {
    case 'payment.captured': {
      const entity = extractPaymentEntity(event.payload);
      if (!entity?.order_id) {
        logger.warn({ eventId: event.eventId, provider: 'razorpay' }, 'webhook_missing_order_id');
        return;
      }
      await applyPaymentCaptured({
        provider: 'razorpay',
        orderId: entity.order_id,
        providerPaymentId: entity.id,
        amount: entity.amount,
        currency: entity.currency,
        eventId: event.eventId,
      });
      return;
    }
    case 'payment.failed': {
      const entity = extractPaymentEntity(event.payload);
      if (!entity?.order_id) {
        logger.warn({ eventId: event.eventId, provider: 'razorpay' }, 'webhook_missing_order_id');
        return;
      }
      await applyPaymentFailed({
        provider: 'razorpay',
        orderId: entity.order_id,
        eventId: event.eventId,
      });
      return;
    }
    case 'refund.processed': {
      const entity = extractRefundEntity(event.payload);
      if (!entity?.id) {
        logger.warn({ eventId: event.eventId, provider: 'razorpay' }, 'webhook_missing_refund_id');
        return;
      }
      // Razorpay refund states: 'processed' = money moved → 'captured';
      // anything else surfaced by this event is a failure → 'failed'. Default
      // to captured for `refund.processed` when status is absent.
      await applyRefundResolution({
        provider: 'razorpay',
        refundId: entity.id,
        targetStatus: entity.status === 'failed' ? 'failed' : 'captured',
        eventId: event.eventId,
      });
      return;
    }
    default:
      // Unknown events: log and ack so Razorpay doesn't retry forever.
      logger.info({ event: event.event, eventId: event.eventId }, 'razorpay_webhook_ignored');
      return;
  }
}

/** A Stripe webhook event: `{ id, type, data: { object } }` on the wire. */
export interface StripeWebhookEvent {
  type: string;
  /** `data.object` — the PaymentIntent / Refund the event describes. */
  object: Record<string, unknown>;
  /** Stripe's event id (`evt_…`) — the idempotency key. */
  eventId: string;
}

/**
 * Stripe webhook fan-out. Same shared cores as Razorpay:
 *   payment_intent.succeeded       → capture (orderId = PaymentIntent id)
 *   payment_intent.payment_failed  → failure
 *   refund.updated / refund.failed → refund resolution (terminal states only)
 */
export async function handleStripeWebhook(event: StripeWebhookEvent): Promise<void> {
  const obj = event.object;
  const objId = typeof obj['id'] === 'string' ? obj['id'] : undefined;

  switch (event.type) {
    case 'payment_intent.succeeded': {
      if (!objId) {
        logger.warn({ eventId: event.eventId, provider: 'stripe' }, 'webhook_missing_order_id');
        return;
      }
      const amountReceived = obj['amount_received'];
      const amount = obj['amount'];
      const latestCharge = obj['latest_charge'];
      const currency = obj['currency'];
      await applyPaymentCaptured({
        provider: 'stripe',
        orderId: objId,
        // The charge id (ch_…) is what refunds reference; fall back to the
        // PaymentIntent id, which Stripe's refund API also accepts.
        providerPaymentId: typeof latestCharge === 'string' ? latestCharge : objId,
        amount:
          typeof amountReceived === 'number'
            ? amountReceived
            : typeof amount === 'number'
              ? amount
              : undefined,
        currency: typeof currency === 'string' ? currency : undefined,
        eventId: event.eventId,
      });
      return;
    }
    case 'payment_intent.payment_failed': {
      if (!objId) {
        logger.warn({ eventId: event.eventId, provider: 'stripe' }, 'webhook_missing_order_id');
        return;
      }
      await applyPaymentFailed({ provider: 'stripe', orderId: objId, eventId: event.eventId });
      return;
    }
    case 'refund.updated':
    case 'refund.failed': {
      if (!objId) {
        logger.warn({ eventId: event.eventId, provider: 'stripe' }, 'webhook_missing_refund_id');
        return;
      }
      const status = obj['status'];
      const failed = status === 'failed' || status === 'canceled';
      // Non-terminal updates ('pending', 'requires_action') don't move the
      // ledger row — the next update (or the sync API response) will.
      if (!failed && status !== 'succeeded') {
        logger.info(
          { refundId: objId, status, eventId: event.eventId },
          'stripe_refund_nonterminal_ignored',
        );
        return;
      }
      await applyRefundResolution({
        provider: 'stripe',
        refundId: objId,
        targetStatus: failed ? 'failed' : 'captured',
        eventId: event.eventId,
      });
      return;
    }
    default:
      // Unknown events: log and ack so Stripe doesn't retry forever.
      logger.info({ type: event.type, eventId: event.eventId }, 'stripe_webhook_ignored');
      return;
  }
}

// ── Shared webhook cores (provider-agnostic) ────────────────────────────────

interface CaptureArgs {
  provider: PaymentProviderId;
  /** The gateway order id we persisted as provider_order_id at create time. */
  orderId: string;
  providerPaymentId?: string | undefined;
  amount?: number | undefined;
  currency?: string | undefined;
  eventId: string;
}

async function applyPaymentCaptured(args: CaptureArgs): Promise<void> {
  const { provider, orderId, providerPaymentId, eventId } = args;

  await db.transaction(async (tx) => {
    const [pay] = await tx
      .select()
      .from(payments)
      .where(eq(payments.providerOrderId, orderId))
      .limit(1);

    if (!pay) {
      // No payments row for this order id — log and ack. Could happen if we
      // missed the createPaymentOrder write but the gateway still saw the payment.
      logger.warn({ orderId, eventId, provider }, 'payment_capture_unknown_order');
      return;
    }

    // Idempotency: replays of the same event find the row already captured.
    if (pay.status === 'captured') {
      logger.info({ paymentId: pay.id, eventId, provider }, 'payment_capture_replay_ignored');
      return;
    }

    // M1: verify the captured amount + currency match the server-side order
    // before holding funds / confirming. The webhook is signed but the *amount*
    // is attacker-influenceable upstream of us; never trust the wire over our
    // own row. On mismatch we leave the row in its current state (pending) and
    // log so ops can investigate — we do NOT confirm the booking.
    const capturedAmount = args.amount;
    const capturedCurrency = args.currency;
    if (typeof capturedAmount !== 'number' || capturedAmount !== Number(pay.amountPaise)) {
      logger.error(
        {
          paymentId: pay.id,
          eventId,
          expectedAmountPaise: Number(pay.amountPaise),
          capturedAmount: capturedAmount ?? null,
        },
        'payment_amount_mismatch',
      );
      return;
    }
    if (typeof capturedCurrency === 'string' && capturedCurrency.toUpperCase() !== pay.currency.toUpperCase()) {
      logger.error(
        {
          paymentId: pay.id,
          eventId,
          expectedCurrency: pay.currency,
          capturedCurrency,
        },
        'payment_amount_mismatch',
      );
      return;
    }

    // M4: status-guarded flip to captured. Only the writer that observes the row
    // still `pending` proceeds; a concurrent duplicate delivery loses the race
    // (no row returned) and is a safe no-op. Flip first so holdForBooking()
    // (which filters on status='captured') can find it inside the same tx.
    const [won] = await tx
      .update(payments)
      .set({
        status: 'captured',
        providerPaymentId: providerPaymentId ?? pay.providerPaymentId,
      })
      .where(and(eq(payments.id, pay.id), eq(payments.status, 'pending')))
      .returning({ id: payments.id });

    if (!won) {
      logger.info({ paymentId: pay.id, eventId, provider }, 'payment_capture_race_lost');
      return;
    }

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
        ${JSON.stringify({ status: 'captured', eventId, providerPaymentId: providerPaymentId ?? null })}::jsonb
      )
    `);

    if (booking) {
      // Mint QR tickets inside this tx (atomic with the confirm; a plain `db`
      // call would not see the uncommitted status flip). Idempotent on replay.
      await issueQrTicketsForBooking(booking.id, tx);
      // Phase 13 wires the actual SMS/email; today this is a no-op stub.
      await notifyBookingConfirmed(booking.id);
    }
  });
}

interface FailureArgs {
  provider: PaymentProviderId;
  orderId: string;
  eventId: string;
}

async function applyPaymentFailed(args: FailureArgs): Promise<void> {
  const { provider, orderId, eventId } = args;

  await db.transaction(async (tx) => {
    const [pay] = await tx
      .select()
      .from(payments)
      .where(eq(payments.providerOrderId, orderId))
      .limit(1);

    if (!pay) {
      logger.warn({ orderId, eventId, provider }, 'payment_failed_unknown_order');
      return;
    }

    // Idempotency: already-failed rows are a no-op replay.
    if (pay.status === 'failed') {
      logger.info({ paymentId: pay.id, eventId, provider }, 'payment_failed_replay_ignored');
      return;
    }

    // M4: status-guarded flip. Only fail a still-`pending` charge; concurrent
    // duplicate deliveries (or a fail racing a capture) lose the guard and
    // no-op rather than clobbering a captured row.
    const [won] = await tx
      .update(payments)
      .set({ status: 'failed' })
      .where(and(eq(payments.id, pay.id), eq(payments.status, 'pending')))
      .returning({ id: payments.id });

    if (!won) {
      logger.info({ paymentId: pay.id, eventId, provider }, 'payment_failed_race_lost');
      return;
    }

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
        ${JSON.stringify({ status: 'failed', eventId })}::jsonb
      )
    `);
  });
}

/**
 * Refund resolution core (Razorpay `refund.processed`, Stripe `refund.*`).
 *
 * `issueRefund`/`runRefund` stores the provider refund id on the refund row's
 * `provider_payment_id` (and kind='refund'). Here we match on that id and move
 * the row to its terminal state: `captured` when the provider reports the money
 * moved, `failed` otherwise.
 *
 * Idempotency + concurrency: the UPDATE is status-guarded to non-terminal
 * states (`pending`/`authorized`). A replay of an already-terminal row returns
 * no row and is a safe no-op. An unknown refund id is logged and acked (2xx) so
 * the gateway stops retrying — it just means we have no local ledger row to
 * flip (e.g. a refund issued out-of-band).
 */
interface RefundResolutionArgs {
  provider: PaymentProviderId;
  /** The gateway's refund id, as persisted on the refund row. */
  refundId: string;
  targetStatus: 'captured' | 'failed';
  eventId: string;
}

async function applyRefundResolution(args: RefundResolutionArgs): Promise<void> {
  const { provider, refundId, targetStatus, eventId } = args;

  await db.transaction(async (tx) => {
    const [refund] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.kind, 'refund'), eq(payments.providerPaymentId, refundId)))
      .limit(1);

    if (!refund) {
      logger.warn({ refundId, eventId, provider }, 'payment_refund_unknown');
      return;
    }

    // Status-guarded transition from a non-terminal state. A replay (row already
    // captured/failed) returns no row → no-op.
    const [won] = await tx
      .update(payments)
      .set({ status: targetStatus })
      .where(
        and(
          eq(payments.id, refund.id),
          sql`${payments.status} in ('pending', 'authorized')`,
        ),
      )
      .returning({ id: payments.id });

    if (!won) {
      logger.info(
        { paymentId: refund.id, refundId, eventId, provider },
        'payment_refund_replay_ignored',
      );
      return;
    }

    await tx.execute(sql`
      insert into audit_log (tenant_id, action, entity_type, entity_id, before, after)
      values (
        ${refund.tenantId}::uuid,
        'payment.refund_processed',
        'payment',
        ${refund.id}::uuid,
        ${JSON.stringify({ status: refund.status })}::jsonb,
        ${JSON.stringify({ status: targetStatus, eventId, refundId })}::jsonb
      )
    `);
  });
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
