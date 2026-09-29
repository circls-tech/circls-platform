/**
 * Payments service — Phase 12 (Track B). Owns the writes against the
 * `payments` table plus the gateway webhook handlers.
 *
 * Contract surfaces (consumed by routes + booking flow):
 *   - createPaymentOrder(): called by booking_service.prepareOnlineBookingWithPayment
 *     when paymentMethod='razorpay_route'. Inserts a `pending` charge row, asks
 *     the payment gateway to create the order, and persists the provider_order_id.
 *   - handleRazorpayWebhook() / handleStripeWebhook() / handleCashfreeWebhook():
 *     called by the /webhooks/* routes (signature verified upstream). Each
 *     extracts its provider's envelope and delegates to the shared apply*
 *     cores, so idempotency and state transitions behave identically per
 *     gateway. payment_recovery_service feeds the same cores from Cashfree's
 *     API when a webhook never arrives.
 *   - resolvePaymentContext(): which gateway/currency a booking charges
 *     through, from the venue's (fallback: tenant's) country and, for INR,
 *     the platform's INR gateway setting.
 *   - listForBooking() / getPayment(): read endpoints used by partner + admin UIs.
 *
 * INR failover: a Cashfree order that can't be created is retried on
 * Razorpay, and repeated Cashfree outages route new INR orders to Razorpay
 * for a cooldown (lib/inr_failover). A booking can therefore carry more than
 * one charge; a second capture for a booking another charge already paid is
 * a duplicate payment and is refunded in full (applyPaymentCaptured).
 *
 * Webhook idempotency strategy: we look up the payments row by
 * `provider_order_id` and short-circuit if it's already in the destination
 * state (status='captured' for a capture; the last-seen failure eventId in
 * metadata for a failure, which no longer transitions status — see
 * applyPaymentFailed). That makes at-least-once retries safe without a
 * separate processed-events table.
 *
 * Retryable-order model: a gateway "payment failed" event is one failed
 * ATTEMPT, not a dead order — Stripe PaymentIntents and Razorpay orders stay
 * payable and the customer can retry in the still-open card form. So failures
 * never cancel the booking here; the abandoned-cart sweep
 * (ABANDONED_CART_GRACE_MIN) is the sole canceller of unpaid pending
 * bookings, and it terminally fails the charge + cancels the gateway order.
 * If a capture still lands after cancellation (Razorpay orders can't be
 * cancelled; a Stripe or Cashfree cancel can lose the race), applyPaymentCaptured
 * records the capture and auto-refunds it in full.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type Booking,
  bookings,
  payments,
  tenants,
  users,
  venues,
  type Payment,
} from '../db/schema/index.js';
import { writeAudit, type AuditCtx } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { cashfreeAmountToMinor, mapCashfreeRefundStatus } from '../lib/cashfree.js';
import {
  currencyForCountry,
  getGateway,
  providerForCountry,
  type GatewayCustomer,
  type GatewayOrder,
  type PaymentProviderId,
} from '../lib/gateway.js';
import { GatewayHttpError } from '../lib/gateway_http.js';
import { isCashfreeFailoverActive, recordCashfreeOutage } from '../lib/inr_failover.js';
import { notifyBookingConfirmed } from './notification_service.js';
import { issueQrTicketsForBooking } from './qr_ticket_service.js';
import { getInrPaymentGateway } from './payment_settings_service.js';
import { issueRefund } from './refund_service.js';
import { holdForBooking } from './settlement_hold_service.js';

export interface PaymentContext {
  provider: PaymentProviderId;
  currency: string;
}

/**
 * Resolve which gateway settles a booking's money: the venue's country when
 * there is one, else the owning tenant's. Everything non-US (including a
 * missing country) charges INR via the platform's INR gateway — the admin's
 * choice (Payments page), else `INR_PAYMENT_GATEWAY` — except that only a
 * client that can open Cashfree's checkout gets Cashfree; any other (older
 * app builds, or no client at all) pays through Razorpay. createPaymentOrder
 * may still fail a Cashfree order over to Razorpay.
 */
export async function resolvePaymentContext(
  opts: {
    venueId?: string | null | undefined;
    tenantId: string;
    /** What the paying client's checkout can open (lib/gateway checkoutGatewaysOf). */
    checkoutGateways?: ReadonlySet<string> | undefined;
  },
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
  let provider = providerForCountry(country, await getInrPaymentGateway());
  if (provider === 'cashfree' && !opts.checkoutGateways?.has('cashfree')) provider = 'razorpay';
  return { provider, currency: currencyForCountry(country) };
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
  /** Consumer-side commission (K) included in amountPaise; Circls money. */
  consumerCommissionPaise?: number;
  /** Partner-side commission snapshot deducted at payout time. */
  partnerCommissionPaise?: number;
  /** Advance-payout tranche paid out after capture, recouped at release. */
  advancePaise?: number;
  /** Billing-config forensics stored in metadata.billing (rates + org fee). */
  billingMetadata?: Record<string, number>;
  /**
   * Gateway to charge through, from resolvePaymentContext. Required so no
   * caller silently bypasses the venue's country or the INR gateway setting.
   * A 'cashfree' order may still land on Razorpay (INR failover).
   */
  provider: PaymentProviderId;
  /** ISO 4217, from resolvePaymentContext. */
  currency: string;
  /** Audit actor — usually the customer (or the admin impersonating them). */
  actorUserId: string;
}

/**
 * The booking's customer as the gateway sees it. Only live Cashfree reads it
 * (its orders require customer details), so it's only loaded then; a booking
 * without a linked user falls back to the booking id as the customer id.
 */
async function loadGatewayCustomer(bookingId: string): Promise<GatewayCustomer> {
  const [row] = await db
    .select({
      userId: users.id,
      phoneE164: users.phoneE164,
      email: users.email,
      displayName: users.displayName,
      customerName: bookings.customerName,
      customerContact: bookings.customerContact,
    })
    .from(bookings)
    .leftJoin(users, eq(users.id, bookings.customerUserId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  // Accounts that signed in by email have no phone_e164, but the checkout
  // still records a contact on the booking — use it when it's a phone number
  // (it may also be an email). Cashfree shows this number on its checkout.
  const contact = row?.customerContact?.trim() ?? '';
  const contactPhone = /^\+?[0-9][0-9\s-]{7,}$/.test(contact) ? contact.replace(/[\s-]/g, '') : null;
  return {
    id: row?.userId ?? bookingId,
    phoneE164: row?.phoneE164 ?? contactPhone,
    email: row?.email ?? null,
    name: row?.displayName ?? row?.customerName ?? null,
  };
}

export interface CreatePaymentOrderResult {
  paymentId: string;
  providerOrderId: string;
  /**
   * The gateway the order was actually created on — 'razorpay' when a
   * 'cashfree' order failed over. Responses to the browser use this, not the
   * requested provider.
   */
  provider: PaymentProviderId;
  /**
   * What the browser needs besides the order id: the Stripe PaymentIntent
   * client secret, or the Cashfree payment session id.
   */
  clientSecret?: string | undefined;
}

/**
 * Create the gateway order for a charge, with INR failover: while Cashfree is
 * in an outage window (lib/inr_failover) a 'cashfree' order goes straight to
 * Razorpay, and a Cashfree order that fails to be created — for any reason —
 * is retried on Razorpay. Only outages count towards the failover window; a
 * rejected request (4xx) still falls back for this one customer. Both
 * gateways charge the same total (checkout_pricing), so the price the
 * customer saw holds.
 */
export async function createPaymentOrder(
  input: CreatePaymentOrderInput,
): Promise<CreatePaymentOrderResult> {
  if (input.provider === 'cashfree' && isCashfreeFailoverActive()) {
    logger.warn({ bookingId: input.bookingId }, 'inr_failover_routed_to_razorpay');
    return mintOrder({ ...input, provider: 'razorpay' }, 'cashfree');
  }
  try {
    return await mintOrder(input);
  } catch (err) {
    if (input.provider !== 'cashfree') throw err;
    if (err instanceof GatewayHttpError && err.outage) recordCashfreeOutage();
    logger.error({ err, bookingId: input.bookingId }, 'cashfree_order_failed_retrying_on_razorpay');
    return mintOrder({ ...input, provider: 'razorpay' }, 'cashfree');
  }
}

/**
 * Two-step write: insert a `pending` charge row first so we have a paymentId to
 * audit even if the gateway's create-order call later fails; then call the
 * gateway and patch the row with the returned order id. The stub adapter never
 * throws, but a live adapter will when creds are missing — the pending row
 * stays as a forensic breadcrumb (marked failed when Cashfree fails over).
 */
async function mintOrder(
  input: CreatePaymentOrderInput,
  failedOverFrom?: 'cashfree',
): Promise<CreatePaymentOrderResult> {
  const gateway = getGateway(input.provider);
  const provider = gateway.mode === 'stub' ? 'stub' : gateway.provider;
  const currency = input.currency;

  const [row] = await db
    .insert(payments)
    .values({
      bookingId: input.bookingId,
      tenantId: input.tenantId,
      provider,
      amountPaise: input.amountPaise,
      settleBasePaise: input.settleBasePaise ?? input.amountPaise,
      consumerCommissionPaise: input.consumerCommissionPaise ?? null,
      partnerCommissionPaise: input.partnerCommissionPaise ?? null,
      advancePaise: input.advancePaise ?? null,
      currency,
      status: 'pending',
      kind: 'charge',
      metadata: {
        ...(input.billingMetadata ? { billing: input.billingMetadata } : {}),
        ...(failedOverFrom ? { failedOverFrom } : {}),
      },
    })
    .returning();
  if (!row) throw new Error('payments insert returned no row');

  let order: GatewayOrder;
  try {
    order = await gateway.createOrder({
      amountMinor: input.amountPaise,
      currency,
      reference: input.bookingId,
      chargeId: row.id,
      ...(gateway.provider === 'cashfree' && gateway.mode === 'live'
        ? { customer: await loadGatewayCustomer(input.bookingId) }
        : {}),
    });
  } catch (err) {
    // A Cashfree order that fails over leaves this row behind; fail it now so
    // it can't be mistaken for the booking's live charge.
    if (gateway.provider === 'cashfree') {
      await db
        .update(payments)
        .set({
          status: 'failed',
          metadata: { ...row.metadata, orderError: err instanceof Error ? err.message : String(err) },
        })
        .where(and(eq(payments.id, row.id), eq(payments.status, 'pending')));
    }
    throw err;
  }

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
    ...(failedOverFrom ? { failedOverFrom } : {}),
  });

  return {
    paymentId: row.id,
    providerOrderId: order.id,
    provider: gateway.provider,
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

/** A Cashfree payment-gateway webhook: `{ type, data, event_time }` on the wire. */
export interface CashfreeWebhookEvent {
  type: string;
  /** `data` — `{ order, payment, … }` for payment events, `{ refund }` for refunds. */
  data: Record<string, unknown>;
  /** `x-idempotency-key` header, else a hash of the signed body. */
  eventId: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** Cashfree ids arrive as strings or numbers depending on webhook version. */
function asId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Cashfree webhook fan-out. Same shared cores as Razorpay/Stripe:
 *   PAYMENT_SUCCESS_WEBHOOK                          → capture (orderId = our order_id)
 *   PAYMENT_FAILED_WEBHOOK / PAYMENT_USER_DROPPED_WEBHOOK → failed attempt
 *   REFUND_STATUS_WEBHOOK                            → refund resolution (terminal only)
 *
 * The capture's amount check uses the ORDER amount — the one we set, carried
 * in the signed payload — not payment_amount: a Cashfree-funded offer or a
 * surcharge makes the payer's amount differ from the order's, and treating
 * that as a mismatch would leave a paid booking unconfirmed and unrefunded.
 * Amounts arrive in rupees and are converted to paise.
 */
export async function handleCashfreeWebhook(event: CashfreeWebhookEvent): Promise<void> {
  const order = asRecord(event.data['order']);
  const payment = asRecord(event.data['payment']);
  const orderId = asId(order?.['order_id']);

  switch (event.type) {
    case 'PAYMENT_SUCCESS_WEBHOOK': {
      if (!orderId) {
        logger.warn({ eventId: event.eventId, provider: 'cashfree' }, 'webhook_missing_order_id');
        return;
      }
      const orderAmount = order?.['order_amount'];
      const amount = typeof orderAmount === 'number' ? orderAmount : payment?.['payment_amount'];
      const currency = order?.['order_currency'] ?? payment?.['payment_currency'];
      await applyPaymentCaptured({
        provider: 'cashfree',
        orderId,
        providerPaymentId: asId(payment?.['cf_payment_id']),
        amount: typeof amount === 'number' ? cashfreeAmountToMinor(amount) : undefined,
        currency: typeof currency === 'string' ? currency : undefined,
        eventId: event.eventId,
      });
      return;
    }
    case 'PAYMENT_FAILED_WEBHOOK':
    case 'PAYMENT_USER_DROPPED_WEBHOOK': {
      // A dropped checkout is just an abandoned attempt — the order stays
      // payable, exactly like a failed one (see the retryable-order model).
      if (!orderId) {
        logger.warn({ eventId: event.eventId, provider: 'cashfree' }, 'webhook_missing_order_id');
        return;
      }
      await applyPaymentFailed({ provider: 'cashfree', orderId, eventId: event.eventId });
      return;
    }
    case 'REFUND_STATUS_WEBHOOK': {
      const refund = asRecord(event.data['refund']);
      const refundId = asId(refund?.['cf_refund_id']);
      if (!refundId) {
        logger.warn({ eventId: event.eventId, provider: 'cashfree' }, 'webhook_missing_refund_id');
        return;
      }
      const status = refund?.['refund_status'];
      const mapped = mapCashfreeRefundStatus(typeof status === 'string' ? status : undefined);
      // PENDING / ONHOLD / PENDING_APPROVAL don't move the ledger row.
      if (mapped === 'pending') {
        logger.info(
          { refundId, status, eventId: event.eventId },
          'cashfree_refund_nonterminal_ignored',
        );
        return;
      }
      await applyRefundResolution({
        provider: 'cashfree',
        refundId,
        targetStatus: mapped === 'failed' ? 'failed' : 'captured',
        eventId: event.eventId,
      });
      return;
    }
    default:
      // Unknown events (incl. AUTO_REFUND_STATUS_WEBHOOK for refunds Cashfree
      // initiated itself, which have no ledger row): log and ack so Cashfree
      // doesn't retry.
      logger.info({ type: event.type, eventId: event.eventId }, 'cashfree_webhook_ignored');
      return;
  }
}

// ── Shared webhook cores (provider-agnostic) ────────────────────────────────

export interface CaptureArgs {
  provider: PaymentProviderId;
  /** The gateway order id we persisted as provider_order_id at create time. */
  orderId: string;
  providerPaymentId?: string | undefined;
  amount?: number | undefined;
  currency?: string | undefined;
  eventId: string;
}

export async function applyPaymentCaptured(args: CaptureArgs): Promise<void> {
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

    // M4: status-guarded flip to captured. 'pending' is the normal path;
    // 'failed' is a capture landing after the sweep (or a manual cancel)
    // terminally failed the charge — gateways allow retries against the same
    // order, so real money can arrive for a row we gave up on, and it MUST be
    // recorded in the ledger (then auto-refunded below when the booking is
    // gone). Concurrent duplicate deliveries lose the guard and no-op. Flip
    // first so holdForBooking() (which filters on status='captured') can find
    // it inside the same tx.
    const [won] = await tx
      .update(payments)
      .set({
        status: 'captured',
        providerPaymentId: providerPaymentId ?? pay.providerPaymentId,
      })
      .where(and(eq(payments.id, pay.id), sql`${payments.status} in ('pending', 'failed')`))
      .returning({ id: payments.id });

    if (!won) {
      logger.info({ paymentId: pay.id, eventId, provider }, 'payment_capture_race_lost');
      return;
    }

    // Confirm the booking — status-guarded so a capture can never resurrect a
    // cancelled booking (its slots were freed and may be rebooked).
    const [booking] = await tx
      .update(bookings)
      .set({ status: 'confirmed' })
      .where(and(eq(bookings.id, pay.bookingId), eq(bookings.status, 'pending')))
      .returning();

    // Advance payouts become payable at capture — but only for charges we
    // keep (both holdForBooking branches). The cancelled-booking auto-refund
    // branch skips this: paying an advance and clawing it straight back would
    // only churn the payout ledger. Idempotent on webhook replay via the
    // null-guard.
    const releaseAdvance = async (): Promise<void> => {
      await tx
        .update(payments)
        .set({ advanceReleasedAt: sql`now()` })
        .where(
          and(
            eq(payments.id, pay.id),
            sql`${payments.advancePaise} > 0`,
            sql`${payments.advanceReleasedAt} is null`,
          ),
        );
    };

    const auditCapture = async (extra: Record<string, unknown> = {}): Promise<void> => {
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
          ${JSON.stringify({ status: 'captured', eventId, providerPaymentId: providerPaymentId ?? null, ...extra })}::jsonb
        )
      `);
    };

    if (booking) {
      // Normal path: funds captured for a live pending booking.
      // Compute settlement_hold_until from the booking's slot end.
      await holdForBooking(pay.bookingId, tx);
      await releaseAdvance();
      await auditCapture();
      // Mint QR tickets inside this tx (atomic with the confirm; a plain `db`
      // call would not see the uncommitted status flip). Idempotent on replay.
      await issueQrTicketsForBooking(booking.id, tx);
      // Phase 13 wires the actual SMS/email; today this is a no-op stub.
      await notifyBookingConfirmed(booking.id);
      return;
    }

    const [bk] = await tx
      .select({ status: bookings.status })
      .from(bookings)
      .where(eq(bookings.id, pay.bookingId))
      .limit(1);

    if (bk?.status === 'cancelled') {
      // Safety net: the customer's retry succeeded after we cancelled the
      // booking (abandoned-cart sweep, manual cancel). The money is real and
      // the slot is gone — record the capture, then refund it in full,
      // atomically with this tx. If the gateway refund call throws, the whole
      // tx rolls back and the gateway redelivers the capture event, so we
      // retry the refund rather than losing it.
      logger.error(
        {
          paymentId: pay.id,
          bookingId: pay.bookingId,
          amountPaise: Number(pay.amountPaise),
          eventId,
          provider,
        },
        'payment_captured_after_cancellation_auto_refunding',
      );
      await auditCapture({ bookingStatus: 'cancelled', autoRefund: true });
      await issueRefund(
        {
          bookingId: pay.bookingId,
          amountPaise: Number(pay.amountPaise),
          reason: 'auto-refund: payment captured after booking cancellation',
          actorUserId: null,
          chargePaymentId: pay.id,
        },
        tx,
      );
      return;
    }

    // Another charge already paid for this booking: a duplicate payment (the
    // customer switched gateway mid-checkout and both payments went through,
    // or a late capture on a failed-over order). Keep one. Record this
    // capture, take it out of the partner's payout (it was never a sale), and
    // refund it in full atomically with this tx — a failed refund call rolls
    // back and the gateway's redelivery retries it.
    const [otherPaid] = await tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.bookingId, pay.bookingId),
          eq(payments.kind, 'charge'),
          ne(payments.id, pay.id),
          sql`${payments.status} in ('captured', 'partially_refunded', 'refunded')`,
        ),
      )
      .limit(1);
    if (otherPaid) {
      logger.error(
        {
          paymentId: pay.id,
          bookingId: pay.bookingId,
          paidBy: otherPaid.id,
          amountPaise: Number(pay.amountPaise),
          eventId,
          provider,
        },
        'payment_duplicate_capture_auto_refunding',
      );
      await tx
        .update(payments)
        .set({
          settleBasePaise: 0,
          consumerCommissionPaise: 0,
          partnerCommissionPaise: 0,
          advancePaise: 0,
        })
        .where(eq(payments.id, pay.id));
      await auditCapture({ duplicateOf: otherPaid.id, autoRefund: true });
      await issueRefund(
        {
          bookingId: pay.bookingId,
          amountPaise: Number(pay.amountPaise),
          reason: 'auto-refund: duplicate payment for an already-paid booking',
          actorUserId: null,
          chargePaymentId: pay.id,
          settleNeutral: true,
        },
        tx,
      );
      return;
    }

    // Booking already confirmed/completed — capture recorded; hold the funds
    // for settlement as usual.
    await holdForBooking(pay.bookingId, tx);
    await releaseAdvance();
    await auditCapture({ bookingStatus: bk?.status ?? null });
  });
}

interface FailureArgs {
  provider: PaymentProviderId;
  orderId: string;
  eventId: string;
}

/**
 * A failed payment attempt is NOT terminal: Stripe PaymentIntents and Razorpay
 * orders stay payable after a failure (typo'd card, abandoned 3DS), and the
 * still-open payment form lets the customer retry against the same order. So
 * we deliberately do NOT fail the charge row or cancel the booking here —
 * doing so used to lose the retry-success capture (the status-guarded capture
 * UPDATE found the row already 'failed' and no-oped: customer charged, no
 * booking). The abandoned-cart sweep is the sole canceller of unpaid pending
 * bookings; it terminally fails the charge and cancels the gateway order.
 *
 * We still record each attempt: an audit row per distinct event plus attempt
 * metadata on the charge row. Idempotency is the last-seen eventId in
 * metadata (there is no status transition to guard on).
 */
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

    // Only a still-pending charge accumulates failure attempts. A capture
    // that already won (or a sweep that already failed the row) makes this a
    // stale delivery.
    if (pay.status !== 'pending') {
      logger.info(
        { paymentId: pay.id, status: pay.status, eventId, provider },
        'payment_failed_stale_ignored',
      );
      return;
    }

    // Idempotency: a redelivery of the same event is a no-op.
    if (pay.metadata['lastFailedEventId'] === eventId) {
      logger.info({ paymentId: pay.id, eventId, provider }, 'payment_failed_replay_ignored');
      return;
    }

    const failedAttempts = Number(pay.metadata['failedAttempts'] ?? 0) + 1;

    // Status-guarded so a concurrent capture flipping the row to 'captured'
    // wins and this metadata stamp no-ops rather than resurrecting staleness.
    const [won] = await tx
      .update(payments)
      .set({
        metadata: { ...pay.metadata, lastFailedEventId: eventId, failedAttempts },
      })
      .where(and(eq(payments.id, pay.id), eq(payments.status, 'pending')))
      .returning({ id: payments.id });

    if (!won) {
      logger.info({ paymentId: pay.id, eventId, provider }, 'payment_failed_race_lost');
      return;
    }

    await tx.execute(sql`
      insert into audit_log (tenant_id, action, entity_type, entity_id, before, after)
      values (
        ${pay.tenantId}::uuid,
        'payment.attempt_failed',
        'payment',
        ${pay.id}::uuid,
        ${JSON.stringify({ status: pay.status })}::jsonb,
        ${JSON.stringify({ status: 'pending', eventId, failedAttempts })}::jsonb
      )
    `);

    logger.info(
      { paymentId: pay.id, bookingId: pay.bookingId, failedAttempts, eventId, provider },
      'payment_attempt_failed_recorded',
    );
  });
}

/**
 * Refund resolution core (Razorpay `refund.processed`, Stripe `refund.*`,
 * Cashfree `REFUND_STATUS_WEBHOOK`, and payment_recovery_service polling).
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
export interface RefundResolutionArgs {
  provider: PaymentProviderId;
  /** The gateway's refund id, as persisted on the refund row. */
  refundId: string;
  targetStatus: 'captured' | 'failed';
  eventId: string;
}

export async function applyRefundResolution(args: RefundResolutionArgs): Promise<void> {
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

export async function listForBooking(bookingId: string, tenantId: string): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.tenantId, tenantId)));
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
