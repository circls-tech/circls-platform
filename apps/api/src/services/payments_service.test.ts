import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import {
  arenas,
  auditLog,
  bookings,
  payments,
  platformSettings,
  slots,
  tenants,
  users,
  venues,
} from '../db/schema/index.js';
import { __resetCashfreeForTesting, getCashfree } from '../lib/cashfree.js';
import { GatewayHttpError } from '../lib/gateway_http.js';
import {
  __resetInrFailoverForTesting,
  cashfreeFailoverState,
  recordCashfreeOutage,
} from '../lib/inr_failover.js';
import {
  __resetPaymentSettingsCacheForTesting,
  getInrPaymentGateway,
  getPaymentSettings,
} from './payment_settings_service.js';
import { env } from '../config/env.js';
import { __resetRazorpayForTesting } from '../lib/razorpay.js';
import { __resetStripeForTesting } from '../lib/stripe.js';
import { cancelPaidBooking } from './cancellation_service.js';
import { createPricingRule } from './pricing_service.js';
import {
  createPaymentOrder,
  handleCashfreeWebhook,
  handleRazorpayWebhook,
  handleStripeWebhook,
  listForBooking,
  resolvePaymentContext,
} from './payments_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

// ---------------------------------------------------------------------------
// Integration: webhook handler — idempotency + capture/failed/refund branches
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('payments_service integration', () => {
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  let userId: string;

  // Monotonically-increasing day counter for seedPendingRefund so that each
  // call produces a distinct November 2031 date and never triggers the
  // slots_no_overlap exclusion constraint on the shared arenaId.
  let _refundSlotDay = 1;

  beforeAll(async () => {
    await pingDb();
    __resetRazorpayForTesting();
    __resetStripeForTesting();
    __resetCashfreeForTesting();

    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `pay-fb-${Date.now()}`, email: `pay-${Date.now()}@test.x` })
      .returning();
    userId = u!.id;

    const [t] = await db
      .insert(tenants)
      .values({
        name: 'Pay Co',
        slug: `payco-${Date.now()}`,
        // The suite asserts customer-pays-all gross-up totals; pin it, since
        // the product default (migration 0064) is 0 = fee waived.
        customerFeeShareBps: 10_000,
      })
      .returning();
    tenantId = t!.id;

    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'V', tzName: 'Asia/Kolkata' })
      .returning();
    venueId = v!.id;

    const [a] = await db.insert(arenas).values({ venueId, name: 'A' }).returning();
    arenaId = a!.id;

    await createPricingRule(arenaId, { pricePaise: 50000, priority: 0 });
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    // notifications table joined by tenantId — drop before tenants FK.
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`update slots set booking_id = null where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slots where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from pricing_rules where arena_id = ${arenaId}`);
    await db.execute(sql`delete from arenas where id = ${arenaId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${userId}`);
    // closeDb() is called by the billing-snapshots suite's afterAll (the last
    // describe in this file) so the shared pool stays open across suites.
  });

  /** Create a fresh pending booking + payment row scoped to a far-future slot. */
  async function seedPendingBookingWithOrder(
    dateIso: string,
    opts?: { provider?: 'razorpay' | 'stripe' | 'cashfree'; currency?: string },
  ): Promise<{
    bookingId: string;
    orderId: string;
    paymentId: string;
  }> {
    // Insert a far-future slot so the time-range upper bound is well after now().
    const [slotRow] = await db.execute<{ id: string }>(sql`
      insert into slots (tenant_id, arena_id, time_range, price_paise, status)
      values (
        ${tenantId}::uuid, ${arenaId}::uuid,
        tstzrange(${dateIso}::timestamptz, (${dateIso}::timestamptz + interval '1 hour'), '[)'),
        50000, 'open'
      )
      returning id
    `);
    const slotId = (slotRow as { id: string }).id;

    const [booking] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'pending',
        customerName: 'WH Test',
        customerContact: '+91-9000000123',
        totalPaise: 50000,
        slotArenaId: arenaId,
        timeRange: `[${dateIso},${new Date(new Date(dateIso).getTime() + 3600_000).toISOString()})`,
        createdByUserId: userId,
      })
      .returning();

    // Link slot to booking so the booking_service flow's invariants hold.
    await db
      .update(slots)
      .set({ status: 'booked', bookingId: booking!.id })
      .where(sql`id = ${slotId}`);

    // Create the order via the service so we get the same flow real traffic uses.
    const order = await createPaymentOrder({
      bookingId: booking!.id,
      tenantId,
      amountPaise: 50000,
      provider: opts?.provider ?? 'razorpay',
      currency: opts?.currency ?? 'INR',
      actorUserId: userId,
    });

    return {
      bookingId: booking!.id,
      orderId: order.providerOrderId,
      paymentId: order.paymentId,
    };
  }

  // Note: do NOT reset the Razorpay stub between tests — its counter mints
  // unique `stub_order_*` ids that we depend on for provider_order_id uniqueness.
  // Resetting on every test would make later tests collide with rows from earlier
  // tests (same order_id), and the webhook lookup `WHERE provider_order_id=…
  // LIMIT 1` would then return the wrong payment. Reset once in beforeAll.

  describe('createPaymentOrder', () => {
    it('inserts a pending charge row and patches provider_order_id', async () => {
      // Zero-pad the day so the ISO string parses on Node's strict Date.
      const dd = String(Math.floor(1 + Math.random() * 28)).padStart(2, '0');
      const dateIso = `2031-08-${dd}T05:00:00.000Z`;
      const seeded = await seedPendingBookingWithOrder(dateIso);

      const row = await db
        .select()
        .from(payments)
        .where(sql`id = ${seeded.paymentId}`);

      expect(row).toHaveLength(1);
      expect(row[0]?.status).toBe('pending');
      expect(row[0]?.kind).toBe('charge');
      expect(row[0]?.amountPaise).toBe(50000);
      expect(row[0]?.providerOrderId).toBe(seeded.orderId);
      // Stub adapter resolves to provider='stub'.
      expect(row[0]?.provider).toBe('stub');

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(sql`entity_id = ${seeded.paymentId} and action = 'payment.order_created'`);
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('handleRazorpayWebhook — payment.captured', () => {
    it('captures the payment, sets settlement_hold_until, confirms booking', async () => {
      const dateIso = '2031-09-05T05:00:00.000Z';
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(dateIso);

      await handleRazorpayWebhook({
        event: 'payment.captured',
        eventId: 'evt_capture_1',
        payload: {
          payment: {
            entity: {
              order_id: orderId,
              id: 'pay_stub_1',
              status: 'captured',
              amount: 50000,
              currency: 'INR',
            },
          },
        },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('captured');
      expect(pay?.providerPaymentId).toBe('pay_stub_1');
      expect(pay?.settlementHoldUntil).not.toBeNull();

      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('confirmed');

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(sql`entity_id = ${paymentId} and action = 'payment.captured'`);
      expect(auditRows.length).toBe(1);
    });

    it('is idempotent — replay of the same eventId is a no-op', async () => {
      const dateIso = '2031-09-12T05:00:00.000Z';
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(dateIso);

      const eventId = 'evt_capture_replay';
      const event = {
        event: 'payment.captured',
        eventId,
        payload: {
          payment: {
            entity: {
              order_id: orderId,
              id: 'pay_stub_2',
              status: 'captured',
              amount: 50000,
              currency: 'INR',
            },
          },
        },
      };

      await handleRazorpayWebhook(event);
      await handleRazorpayWebhook(event); // replay

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(sql`entity_id = ${paymentId} and action = 'payment.captured'`);
      // Only the first call writes an audit row — the second short-circuits.
      expect(auditRows.length).toBe(1);

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('captured');

      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('confirmed');
    });

    // M1: a captured amount that disagrees with the stored order amount must NOT
    // confirm the booking nor flip the row to captured. The row stays pending so
    // ops can investigate (the handler logs `payment_amount_mismatch`).
    it('does NOT capture/confirm when the webhook amount != order amount', async () => {
      const dateIso = '2031-09-19T05:00:00.000Z';
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(dateIso);

      await handleRazorpayWebhook({
        event: 'payment.captured',
        eventId: 'evt_capture_mismatch',
        payload: {
          payment: {
            // 49999 != stored 50000.
            entity: { order_id: orderId, id: 'pay_stub_bad', status: 'captured', amount: 49999, currency: 'INR' },
          },
        },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('pending'); // unchanged
      expect(pay?.providerPaymentId).toBeNull(); // not patched

      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('pending'); // NOT confirmed

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(sql`entity_id = ${paymentId} and action = 'payment.captured'`);
      expect(auditRows.length).toBe(0);
    });

    // M1: currency mismatch is also rejected.
    it('does NOT capture when the webhook currency != order currency', async () => {
      const dateIso = '2031-09-26T05:00:00.000Z';
      const { paymentId } = await seedPendingBookingWithOrder(dateIso);

      await handleRazorpayWebhook({
        event: 'payment.captured',
        eventId: 'evt_capture_cur_mismatch',
        payload: {
          payment: {
            entity: { order_id: (await db.select().from(payments).where(sql`id = ${paymentId}`))[0]!.providerOrderId!, id: 'pay_stub_cur', status: 'captured', amount: 50000, currency: 'USD' },
          },
        },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('pending');
    });

    // M4: a second delivery of the same capture is a no-op — the status-guarded
    // UPDATE matches no `pending` row the second time, so exactly one audit row
    // (one confirmation side effect) results.
    it('M4: duplicate capture deliveries confirm exactly once', async () => {
      const dateIso = '2031-09-30T05:00:00.000Z';
      const { paymentId } = await seedPendingBookingWithOrder(dateIso);

      const orderId = (await db.select().from(payments).where(sql`id = ${paymentId}`))[0]!
        .providerOrderId!;
      const mk = (eventId: string) => ({
        event: 'payment.captured',
        eventId,
        payload: {
          payment: {
            entity: { order_id: orderId, id: 'pay_stub_m4', status: 'captured', amount: 50000, currency: 'INR' },
          },
        },
      });

      // Distinct eventIds so we bypass the cheap status pre-check and exercise
      // the status-guarded UPDATE on the second call.
      await handleRazorpayWebhook(mk('evt_m4_a'));
      await handleRazorpayWebhook(mk('evt_m4_b'));

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(sql`entity_id = ${paymentId} and action = 'payment.captured'`);
      expect(auditRows.length).toBe(1);

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('captured');
    });
  });

  describe('handleRazorpayWebhook — payment.failed', () => {
    // A failed attempt is retryable (the customer's card form stays open), so
    // it must NOT fail the charge or cancel the booking — only the
    // abandoned-cart sweep cancels unpaid pending bookings.
    it('records the attempt but keeps the payment and booking pending', async () => {
      const dateIso = '2031-10-04T05:00:00.000Z';
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(dateIso);

      await handleRazorpayWebhook({
        event: 'payment.failed',
        eventId: 'evt_fail_1',
        payload: { payment: { entity: { order_id: orderId, id: 'pay_stub_x' } } },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('pending');
      expect(pay?.metadata['failedAttempts']).toBe(1);
      expect(pay?.metadata['lastFailedEventId']).toBe('evt_fail_1');

      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('pending');

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(sql`entity_id = ${paymentId} and action = 'payment.attempt_failed'`);
      expect(auditRows.length).toBe(1);
    });

    it('replays are deduped by eventId; distinct attempts accumulate', async () => {
      const dateIso = '2031-10-11T05:00:00.000Z';
      const { orderId, paymentId } = await seedPendingBookingWithOrder(dateIso);

      const mk = (eventId: string) => ({
        event: 'payment.failed',
        eventId,
        payload: { payment: { entity: { order_id: orderId, id: 'pay_stub_y' } } },
      });
      await handleRazorpayWebhook(mk('evt_fail_r1'));
      await handleRazorpayWebhook(mk('evt_fail_r1')); // replay — no-op
      await handleRazorpayWebhook(mk('evt_fail_r2')); // a second real attempt

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.metadata['failedAttempts']).toBe(2);

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(sql`entity_id = ${paymentId} and action = 'payment.attempt_failed'`);
      expect(auditRows.length).toBe(2);
    });

    // THE money-losing race this change exists for: a failed 3DS attempt
    // followed by a successful retry against the same order must end
    // captured + confirmed, not 'payment_capture_race_lost'.
    it('fail → retry-success ends with the payment captured and booking confirmed', async () => {
      const dateIso = '2031-10-18T05:00:00.000Z';
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(dateIso);

      await handleRazorpayWebhook({
        event: 'payment.failed',
        eventId: 'evt_fail_then_ok_1',
        payload: { payment: { entity: { order_id: orderId, id: 'pay_stub_f1' } } },
      });
      await handleRazorpayWebhook({
        event: 'payment.captured',
        eventId: 'evt_fail_then_ok_2',
        payload: {
          payment: {
            entity: { order_id: orderId, id: 'pay_stub_retry', status: 'captured', amount: 50000, currency: 'INR' },
          },
        },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('captured');
      expect(pay?.providerPaymentId).toBe('pay_stub_retry');

      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('confirmed');
    });
  });

  describe('handleRazorpayWebhook — refund.processed', () => {
    /**
     * Seed a refund ledger row directly, mirroring what runRefund() persists: a
     * negative-amount `refund` row whose provider refund id lives on
     * provider_payment_id, status 'pending' (awaiting the processed webhook).
     */
    async function seedPendingRefund(refundProviderId: string): Promise<{
      bookingId: string;
      refundRowId: string;
    }> {
      const dateIso = `2031-11-${String(_refundSlotDay++).padStart(2, '0')}T05:00:00.000Z`;
      const { bookingId } = await seedPendingBookingWithOrder(dateIso);
      const [r] = await db
        .insert(payments)
        .values({
          bookingId,
          tenantId,
          provider: 'razorpay',
          providerPaymentId: refundProviderId,
          amountPaise: -50000,
          currency: 'INR',
          status: 'pending',
          kind: 'refund',
          metadata: {},
        })
        .returning();
      return { bookingId, refundRowId: r!.id };
    }

    // M2: a refund.processed webhook flips the pending refund row to captured.
    it('transitions a pending refund row to captured', async () => {
      const { refundRowId } = await seedPendingRefund('rfnd_proc_1');

      await handleRazorpayWebhook({
        event: 'refund.processed',
        eventId: 'evt_refund_proc_1',
        payload: { refund: { entity: { id: 'rfnd_proc_1', status: 'processed', amount: 50000 } } },
      });

      const [row] = await db.select().from(payments).where(sql`id = ${refundRowId}`);
      expect(row?.status).toBe('captured');

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(sql`entity_id = ${refundRowId} and action = 'payment.refund_processed'`);
      expect(auditRows.length).toBe(1);
    });

    // M2: a replay is idempotent — the status-guarded UPDATE matches no
    // non-terminal row the second time, so no second audit row is written.
    it('is idempotent on replay (no double-apply)', async () => {
      const { refundRowId } = await seedPendingRefund('rfnd_proc_replay');

      const event = {
        event: 'refund.processed',
        eventId: 'evt_refund_replay',
        payload: { refund: { entity: { id: 'rfnd_proc_replay', status: 'processed' } } },
      };
      await handleRazorpayWebhook(event);
      await handleRazorpayWebhook(event); // replay

      const [row] = await db.select().from(payments).where(sql`id = ${refundRowId}`);
      expect(row?.status).toBe('captured');

      const auditRows = await db
        .select()
        .from(auditLog)
        .where(sql`entity_id = ${refundRowId} and action = 'payment.refund_processed'`);
      expect(auditRows.length).toBe(1);
    });

    // M2: a failure event flips the refund row to failed.
    it('flips the refund row to failed on a failure event', async () => {
      const { refundRowId } = await seedPendingRefund('rfnd_fail_1');

      await handleRazorpayWebhook({
        event: 'refund.processed',
        eventId: 'evt_refund_fail_1',
        payload: { refund: { entity: { id: 'rfnd_fail_1', status: 'failed' } } },
      });

      const [row] = await db.select().from(payments).where(sql`id = ${refundRowId}`);
      expect(row?.status).toBe('failed');
    });

    // M2: an unknown refund id is acked without throwing and changes nothing.
    it('acks an unknown refund id without error', async () => {
      await expect(
        handleRazorpayWebhook({
          event: 'refund.processed',
          eventId: 'evt_refund_unknown',
          payload: { refund: { entity: { id: 'rfnd_does_not_exist', status: 'processed' } } },
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('handleStripeWebhook', () => {
    it('payment_intent.succeeded captures the payment and confirms the booking', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-01-05T05:00:00.000Z',
        { provider: 'stripe', currency: 'USD' },
      );
      expect(orderId).toMatch(/^stub_pi_/);

      await handleStripeWebhook({
        type: 'payment_intent.succeeded',
        eventId: 'evt_stripe_capture_1',
        object: {
          id: orderId,
          amount: 50000,
          amount_received: 50000,
          currency: 'usd',
          latest_charge: 'ch_stub_1',
        },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('captured');
      expect(pay?.providerPaymentId).toBe('ch_stub_1');
      expect(pay?.currency).toBe('USD');
      expect(pay?.settlementHoldUntil).not.toBeNull();

      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('confirmed');
    });

    it('rejects a capture whose amount disagrees with the order (M1)', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-01-12T05:00:00.000Z',
        { provider: 'stripe', currency: 'USD' },
      );

      await handleStripeWebhook({
        type: 'payment_intent.succeeded',
        eventId: 'evt_stripe_mismatch',
        object: { id: orderId, amount_received: 49999, currency: 'usd', latest_charge: 'ch_bad' },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('pending');
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('pending');
    });

    it('rejects a capture whose currency disagrees with the order (M1)', async () => {
      const { orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-01-19T05:00:00.000Z',
        { provider: 'stripe', currency: 'USD' },
      );

      await handleStripeWebhook({
        type: 'payment_intent.succeeded',
        eventId: 'evt_stripe_cur_mismatch',
        object: { id: orderId, amount_received: 50000, currency: 'inr', latest_charge: 'ch_cur' },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('pending');
    });

    // A PaymentIntent is retryable after a failed attempt (e.g. abandoned
    // 3DS) — the failure must not fail the charge or cancel the booking.
    it('payment_intent.payment_failed keeps the payment and booking pending', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-01-26T05:00:00.000Z',
        { provider: 'stripe', currency: 'USD' },
      );

      await handleStripeWebhook({
        type: 'payment_intent.payment_failed',
        eventId: 'evt_stripe_fail_1',
        object: { id: orderId },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('pending');
      expect(pay?.metadata['failedAttempts']).toBe(1);
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('pending');
    });

    // Reproduces the live Stripe test-mode incident: failed 3DS attempt, the
    // customer retries in the still-open Payment Element, the same intent
    // succeeds. Must end captured + confirmed.
    it('payment_failed → payment_intent.succeeded retry confirms the booking', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-02-09T05:00:00.000Z',
        { provider: 'stripe', currency: 'USD' },
      );

      await handleStripeWebhook({
        type: 'payment_intent.payment_failed',
        eventId: 'evt_stripe_retry_fail',
        object: { id: orderId },
      });
      await handleStripeWebhook({
        type: 'payment_intent.succeeded',
        eventId: 'evt_stripe_retry_ok',
        object: {
          id: orderId,
          amount: 50000,
          amount_received: 50000,
          currency: 'usd',
          latest_charge: 'ch_stub_retry',
        },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('captured');
      expect(pay?.providerPaymentId).toBe('ch_stub_retry');
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('confirmed');
    });

    it('refund.updated succeeded flips a pending refund row to captured; pending is ignored', async () => {
      const { bookingId } = await seedPendingBookingWithOrder('2032-02-02T05:00:00.000Z', {
        provider: 'stripe',
        currency: 'USD',
      });
      const [r] = await db
        .insert(payments)
        .values({
          bookingId,
          tenantId,
          provider: 'stripe',
          providerPaymentId: 're_stub_1',
          amountPaise: -50000,
          currency: 'USD',
          status: 'pending',
          kind: 'refund',
          metadata: {},
        })
        .returning();

      // Non-terminal update: no state change.
      await handleStripeWebhook({
        type: 'refund.updated',
        eventId: 'evt_stripe_refund_pending',
        object: { id: 're_stub_1', status: 'pending' },
      });
      let [row] = await db.select().from(payments).where(sql`id = ${r!.id}`);
      expect(row?.status).toBe('pending');

      await handleStripeWebhook({
        type: 'refund.updated',
        eventId: 'evt_stripe_refund_done',
        object: { id: 're_stub_1', status: 'succeeded' },
      });
      [row] = await db.select().from(payments).where(sql`id = ${r!.id}`);
      expect(row?.status).toBe('captured');
    });

    it('acks unknown event types without error', async () => {
      await expect(
        handleStripeWebhook({
          type: 'customer.created',
          eventId: 'evt_stripe_unknown',
          object: { id: 'cus_1' },
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('handleCashfreeWebhook', () => {
    it('PAYMENT_SUCCESS_WEBHOOK captures (rupees → paise) and confirms the booking', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-03-01T05:00:00.000Z',
        { provider: 'cashfree' },
      );
      expect(orderId).toMatch(/^stub_cforder_/);

      await handleCashfreeWebhook({
        type: 'PAYMENT_SUCCESS_WEBHOOK',
        eventId: 'cf_idem_capture_1',
        data: {
          order: { order_id: orderId, order_amount: 500, order_currency: 'INR' },
          // Older webhook versions send cf_payment_id as a number.
          payment: {
            cf_payment_id: 9876543210,
            payment_status: 'SUCCESS',
            payment_amount: 500.0,
            payment_currency: 'INR',
          },
        },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('captured');
      expect(pay?.providerPaymentId).toBe('9876543210');
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('confirmed');
    });

    it('rejects a capture whose amount disagrees with the order (M1)', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-03-08T05:00:00.000Z',
        { provider: 'cashfree' },
      );

      await handleCashfreeWebhook({
        type: 'PAYMENT_SUCCESS_WEBHOOK',
        eventId: 'cf_idem_mismatch',
        data: {
          order: { order_id: orderId },
          payment: { cf_payment_id: '111', payment_amount: 499.99, payment_currency: 'INR' },
        },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('pending');
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('pending');
    });

    it('failed and user-dropped attempts keep the payment and booking pending', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-03-15T05:00:00.000Z',
        { provider: 'cashfree' },
      );

      await handleCashfreeWebhook({
        type: 'PAYMENT_FAILED_WEBHOOK',
        eventId: 'cf_idem_fail_1',
        data: { order: { order_id: orderId }, payment: { payment_status: 'FAILED' } },
      });
      await handleCashfreeWebhook({
        type: 'PAYMENT_USER_DROPPED_WEBHOOK',
        eventId: 'cf_idem_drop_1',
        data: { order: { order_id: orderId }, payment: { payment_status: 'USER_DROPPED' } },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('pending');
      expect(pay?.metadata['failedAttempts']).toBe(2);
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('pending');
    });

    it('REFUND_STATUS_WEBHOOK SUCCESS flips a pending refund row to captured; PENDING is ignored', async () => {
      const { bookingId } = await seedPendingBookingWithOrder('2032-03-22T05:00:00.000Z', {
        provider: 'cashfree',
      });
      const [r] = await db
        .insert(payments)
        .values({
          bookingId,
          tenantId,
          provider: 'cashfree',
          providerPaymentId: '11325632',
          amountPaise: -50000,
          currency: 'INR',
          status: 'pending',
          kind: 'refund',
          metadata: {},
        })
        .returning();

      await handleCashfreeWebhook({
        type: 'REFUND_STATUS_WEBHOOK',
        eventId: 'cf_idem_refund_pending',
        data: { refund: { cf_refund_id: 11325632, refund_status: 'PENDING' } },
      });
      let [row] = await db.select().from(payments).where(sql`id = ${r!.id}`);
      expect(row?.status).toBe('pending');

      await handleCashfreeWebhook({
        type: 'REFUND_STATUS_WEBHOOK',
        eventId: 'cf_idem_refund_done',
        data: { refund: { cf_refund_id: 11325632, refund_status: 'SUCCESS' } },
      });
      [row] = await db.select().from(payments).where(sql`id = ${r!.id}`);
      expect(row?.status).toBe('captured');
    });

    it('acks unknown event types without error', async () => {
      await expect(
        handleCashfreeWebhook({
          type: 'PAYMENT_CHARGES_WEBHOOK',
          eventId: 'cf_idem_unknown',
          data: {},
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('capture after cancellation — auto-refund safety net', () => {
    /** Simulate the abandoned-cart sweep on a seeded pending booking. */
    async function sweepLike(bookingId: string, paymentId: string): Promise<void> {
      await db.execute(
        sql`update slots set status = 'open', booking_id = null where booking_id = ${bookingId}`,
      );
      await db.update(bookings).set({ status: 'cancelled' }).where(sql`id = ${bookingId}`);
      await db.update(payments).set({ status: 'failed' }).where(sql`id = ${paymentId}`);
    }

    // The full incident flow: sweep cancelled the booking and failed the
    // charge, then the customer's retry captured the money anyway (Stripe
    // cancel lost the race / Razorpay order can't be cancelled). The capture
    // must be recorded in the ledger and refunded in full — never dropped as
    // 'payment_capture_race_lost', and never resurrecting the booking.
    it('records a late capture on a failed charge and auto-refunds it in full', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-03-02T05:00:00.000Z',
        { provider: 'stripe', currency: 'USD' },
      );
      await sweepLike(bookingId, paymentId);

      await handleStripeWebhook({
        type: 'payment_intent.succeeded',
        eventId: 'evt_stripe_late_capture',
        object: {
          id: orderId,
          amount: 50000,
          amount_received: 50000,
          currency: 'usd',
          latest_charge: 'ch_late_1',
        },
      });

      // Charge: captured, then flipped to 'refunded' by the auto-refund.
      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('refunded');
      expect(pay?.providerPaymentId).toBe('ch_late_1');

      // Booking stays cancelled — a late capture must not resurrect it.
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('cancelled');

      // Full-amount refund ledger row (stub provider resolves instantly).
      const refunds = await db
        .select()
        .from(payments)
        .where(sql`booking_id = ${bookingId} and kind = 'refund'`);
      expect(refunds).toHaveLength(1);
      expect(Number(refunds[0]?.amountPaise)).toBe(-50000);
      expect(refunds[0]?.status).toBe('captured');

      const captureAudit = await db
        .select()
        .from(auditLog)
        .where(sql`entity_id = ${paymentId} and action = 'payment.captured'`);
      expect(captureAudit.length).toBe(1);
      const refundAudit = await db
        .select()
        .from(auditLog)
        .where(sql`entity_id = ${refunds[0]!.id} and action = 'payment.refunded'`);
      expect(refundAudit.length).toBe(1);
    });

    // Same net, different entry: the booking was cancelled but the charge row
    // is still 'pending' (e.g. a cancel path that predates the charge flip).
    it('auto-refunds a capture for a cancelled booking whose charge is still pending', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-03-09T05:00:00.000Z',
        { provider: 'stripe', currency: 'USD' },
      );
      await db.execute(
        sql`update slots set status = 'open', booking_id = null where booking_id = ${bookingId}`,
      );
      await db.update(bookings).set({ status: 'cancelled' }).where(sql`id = ${bookingId}`);

      await handleStripeWebhook({
        type: 'payment_intent.succeeded',
        eventId: 'evt_stripe_late_capture_2',
        object: {
          id: orderId,
          amount: 50000,
          amount_received: 50000,
          currency: 'usd',
          latest_charge: 'ch_late_2',
        },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('refunded');
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('cancelled');
      const refunds = await db
        .select()
        .from(payments)
        .where(sql`booking_id = ${bookingId} and kind = 'refund'`);
      expect(refunds).toHaveLength(1);
    });

    // A replay of the capture after the auto-refund must not double-refund:
    // the charge is 'refunded', which the capture guard does not match.
    it('is idempotent — replaying the late capture does not refund twice', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-03-16T05:00:00.000Z',
        { provider: 'stripe', currency: 'USD' },
      );
      await sweepLike(bookingId, paymentId);

      const event = {
        type: 'payment_intent.succeeded',
        eventId: 'evt_stripe_late_replay',
        object: {
          id: orderId,
          amount: 50000,
          amount_received: 50000,
          currency: 'usd',
          latest_charge: 'ch_late_3',
        },
      };
      await handleStripeWebhook(event);
      await handleStripeWebhook({ ...event, eventId: 'evt_stripe_late_replay_2' });

      const refunds = await db
        .select()
        .from(payments)
        .where(sql`booking_id = ${bookingId} and kind = 'refund'`);
      expect(refunds).toHaveLength(1);
    });
  });

  describe('cancelPaidBooking on a booking with more than one charge', () => {
    // A checkout moved from Cashfree to Razorpay: the retired Cashfree charge
    // C1 and the pending Razorpay charge C2. The customer's Cashfree payment
    // lands on C1 just as someone cancels the booking.
    it('a capture on the other charge is seen, and refunded, by a concurrent cancel', async () => {
      const { bookingId, paymentId: c1 } = await seedPendingBookingWithOrder(
        '2032-04-13T05:00:00.000Z',
        { provider: 'cashfree' },
      );
      await db.update(payments).set({ status: 'failed' }).where(sql`id = ${c1}`);
      await createPaymentOrder({
        bookingId,
        tenantId,
        amountPaise: 50000,
        provider: 'razorpay',
        currency: 'INR',
        actorUserId: userId,
      });

      // The capture holds C1 and the booking, uncommitted, while the cancel starts.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let onCaptured!: () => void;
      const captured = new Promise<void>((r) => (onCaptured = r));
      const capture = db.transaction(async (tx) => {
        await tx
          .update(payments)
          .set({ status: 'captured', providerPaymentId: `cfpay_race_${Date.now()}` })
          .where(sql`id = ${c1}`);
        await tx.update(bookings).set({ status: 'confirmed' }).where(sql`id = ${bookingId}`);
        onCaptured();
        await held;
      });
      await captured;
      const cancel = cancelPaidBooking({ bookingId, actorUserId: userId, reason: 'race', bySelf: false });
      await new Promise((r) => setTimeout(r, 300));
      release();
      await capture;
      const res = await cancel;

      // Not "uncaptured, refund 0" read from C2: the cancel waited on C1,
      // saw the payment and refunded it.
      expect(res.refundPaise).toBe(50000);
      const refunds = await db
        .select()
        .from(payments)
        .where(sql`booking_id = ${bookingId} and kind = 'refund'`);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.metadata['chargePaymentId']).toBe(c1);
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('cancelled');
    });
  });

  describe('cancelPaidBooking on an unpaid pending booking', () => {
    it('fails the charge, refunds nothing, and reports refundPaise 0', async () => {
      const { bookingId, paymentId } = await seedPendingBookingWithOrder(
        '2032-04-06T05:00:00.000Z',
      );

      const res = await cancelPaidBooking({
        bookingId,
        actorUserId: userId,
        reason: 'customer walked away from checkout',
        bySelf: false,
      });

      // Nothing was captured, so nothing can be refunded — whatever the
      // cancellation policy tier would have paid out — and the tier says so.
      expect(res.refundPaise).toBe(0);
      expect(res.policy).toBe('uncaptured');
      expect(res.refundId).toBeUndefined();

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('failed');
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('cancelled');

      const refunds = await db
        .select()
        .from(payments)
        .where(sql`booking_id = ${bookingId} and kind = 'refund'`);
      expect(refunds).toHaveLength(0);
    });
  });

  describe('Cashfree captures with offers or surcharges', () => {
    it('confirms on the ORDER amount when the payer paid a different amount', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-05-03T05:00:00.000Z',
        { provider: 'cashfree' },
      );
      await handleCashfreeWebhook({
        type: 'PAYMENT_SUCCESS_WEBHOOK',
        eventId: `cf_offer_${Date.now()}`,
        data: {
          order: { order_id: orderId, order_amount: 500, order_currency: 'INR' },
          // A Cashfree-funded offer knocked ₹50 off what the customer paid.
          payment: {
            cf_payment_id: `cfp_offer_${Date.now()}`,
            payment_status: 'SUCCESS',
            payment_amount: 450,
            payment_currency: 'INR',
          },
        },
      });
      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('captured');
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('confirmed');
    });
  });

  describe('duplicate payments', () => {
    it('refunds a second capture on an already-paid booking, outside the payout', async () => {
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(
        '2032-05-10T05:00:00.000Z',
      );
      const capture = (order: string, payId: string, eventId: string) =>
        handleRazorpayWebhook({
          event: 'payment.captured',
          eventId,
          payload: {
            payment: {
              entity: { order_id: order, id: payId, status: 'captured', amount: 50000, currency: 'INR' },
            },
          },
        });
      const stamp = Date.now();
      await capture(orderId, `pay_dup_a_${stamp}`, `evt_dup_a_${stamp}`);

      // The customer also paid a second checkout for the same booking (e.g.
      // they switched gateway and both payments went through).
      const second = await createPaymentOrder({
        bookingId,
        tenantId,
        amountPaise: 50000,
        settleBasePaise: 48000,
        partnerCommissionPaise: 1500,
        provider: 'razorpay',
        currency: 'INR',
        actorUserId: userId,
      });
      await db.update(payments).set({ status: 'failed' }).where(sql`id = ${second.paymentId}`);
      await capture(second.providerOrderId, `pay_dup_b_${stamp}`, `evt_dup_b_${stamp}`);

      const [first] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(first?.status).toBe('captured');
      const [dup] = await db.select().from(payments).where(sql`id = ${second.paymentId}`);
      expect(dup?.status).toBe('refunded');
      // Never a sale: out of the partner's gross and commission.
      expect(Number(dup?.settleBasePaise)).toBe(0);
      expect(Number(dup?.partnerCommissionPaise)).toBe(0);
      const refunds = await db
        .select()
        .from(payments)
        .where(sql`booking_id = ${bookingId} and kind = 'refund'`);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.metadata['chargePaymentId']).toBe(second.paymentId);
      expect(Number(refunds[0]!.amountPaise)).toBe(-50000);
      expect(Number(refunds[0]!.settleBasePaise)).toBe(0);
      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('confirmed');
    });
  });

  describe('INR failover', () => {
    const outage = () => new GatewayHttpError('Cashfree /orders failed (503): down', 'cashfree', 503, true);

    it('retries a Cashfree order that fails on Razorpay and records the outage', async () => {
      __resetInrFailoverForTesting();
      const { bookingId } = await seedPendingBookingWithOrder('2032-05-17T05:00:00.000Z');
      const spy = vi.spyOn(getCashfree(), 'createOrder').mockRejectedValueOnce(outage());
      try {
        const result = await createPaymentOrder({
          bookingId,
          tenantId,
          amountPaise: 50000,
          provider: 'cashfree',
          currency: 'INR',
          actorUserId: userId,
        });
        expect(result.provider).toBe('razorpay');
        expect(result.providerOrderId).toMatch(/^stub_order_/);
        const rows = await db
          .select()
          .from(payments)
          .where(sql`booking_id = ${bookingId} and kind = 'charge'`)
          .orderBy(sql`created_at asc`);
        // [initial seed order, dead Cashfree attempt, Razorpay retry]
        const dead = rows[rows.length - 2]!;
        const retry = rows[rows.length - 1]!;
        expect(dead.status).toBe('failed');
        expect(dead.metadata['orderError']).toMatch(/503/);
        expect(retry.status).toBe('pending');
        expect(retry.id).toBe(result.paymentId);
        expect(retry.metadata['failedOverFrom']).toBe('cashfree');
        expect(cashfreeFailoverState().recentOutages).toBe(1);
      } finally {
        spy.mockRestore();
        __resetInrFailoverForTesting();
      }
    });

    it('while failover is active, Cashfree orders go straight to Razorpay', async () => {
      __resetInrFailoverForTesting();
      for (let i = 0; i < 3; i++) recordCashfreeOutage();
      const { bookingId } = await seedPendingBookingWithOrder('2032-05-24T05:00:00.000Z');
      const spy = vi.spyOn(getCashfree(), 'createOrder');
      try {
        const result = await createPaymentOrder({
          bookingId,
          tenantId,
          amountPaise: 50000,
          provider: 'cashfree',
          currency: 'INR',
          actorUserId: userId,
        });
        expect(spy).not.toHaveBeenCalled();
        expect(result.provider).toBe('razorpay');
      } finally {
        spy.mockRestore();
        __resetInrFailoverForTesting();
      }
    });

    it('a refused Cashfree order still falls back but is not an outage', async () => {
      __resetInrFailoverForTesting();
      const { bookingId } = await seedPendingBookingWithOrder('2032-05-31T05:00:00.000Z');
      const spy = vi
        .spyOn(getCashfree(), 'createOrder')
        .mockRejectedValueOnce(
          new GatewayHttpError('Cashfree /orders failed (400): bad phone', 'cashfree', 400, false),
        );
      try {
        const result = await createPaymentOrder({
          bookingId,
          tenantId,
          amountPaise: 50000,
          provider: 'cashfree',
          currency: 'INR',
          actorUserId: userId,
        });
        expect(result.provider).toBe('razorpay');
        expect(cashfreeFailoverState().recentOutages).toBe(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('INR gateway setting', () => {
    // Inside a booking transaction, a read on the global pool takes a second
    // connection while the first holds row locks: enough concurrent bookings
    // exhaust the pool with every holder waiting for another connection.
    it("is read on the caller's transaction, not the global pool", async () => {
      const [inVenue] = await db
        .insert(venues)
        .values({ tenantId, name: 'IN tx', tzName: 'Asia/Kolkata', country: 'India' })
        .returning();
      __resetPaymentSettingsCacheForTesting();
      const spy = vi.spyOn(db, 'select');
      try {
        await db.transaction(async (tx) => {
          const ctx = await resolvePaymentContext({ venueId: inVenue!.id, tenantId }, tx);
          expect(ctx.currency).toBe('INR');
        });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        await db.execute(sql`delete from venues where id = ${inVenue!.id}`);
      }
    });

    it('in production, a stored Cashfree choice without keys falls back to Razorpay', async () => {
      const [saved] = await db
        .select()
        .from(platformSettings)
        .where(sql`key = 'inr_payment_gateway'`);
      const prevNodeEnv = env.NODE_ENV;
      try {
        await db
          .insert(platformSettings)
          .values({ key: 'inr_payment_gateway', value: 'cashfree' })
          .onConflictDoUpdate({ target: platformSettings.key, set: { value: 'cashfree' } });
        __resetPaymentSettingsCacheForTesting();
        // Tests run Cashfree as a stub: no keys, as after they're removed.
        (env as { NODE_ENV: string }).NODE_ENV = 'production';
        expect(await getInrPaymentGateway()).toBe('razorpay');
        await expect(getPaymentSettings()).resolves.toMatchObject({
          inrGateway: 'razorpay',
          unusableChoice: 'cashfree',
        });
      } finally {
        (env as { NODE_ENV: string }).NODE_ENV = prevNodeEnv;
        if (saved) {
          await db
            .update(platformSettings)
            .set({ value: saved.value })
            .where(sql`key = 'inr_payment_gateway'`);
        } else {
          await db.delete(platformSettings).where(sql`key = 'inr_payment_gateway'`);
        }
        __resetPaymentSettingsCacheForTesting();
      }
    });

    it("routes Indian venues to the admin's pick, if the client can open it", async () => {
      const [inVenue] = await db
        .insert(venues)
        .values({ tenantId, name: 'IN V2', tzName: 'Asia/Kolkata', country: 'India' })
        .returning();
      const [saved] = await db
        .select()
        .from(platformSettings)
        .where(sql`key = 'inr_payment_gateway'`);
      try {
        await db
          .insert(platformSettings)
          .values({ key: 'inr_payment_gateway', value: 'cashfree' })
          .onConflictDoUpdate({ target: platformSettings.key, set: { value: 'cashfree' } });
        __resetPaymentSettingsCacheForTesting();
        const website = new Set(['razorpay', 'stripe', 'cashfree']);
        expect(
          await resolvePaymentContext({ venueId: inVenue!.id, tenantId, checkoutGateways: website }),
        ).toEqual({ provider: 'cashfree', currency: 'INR' });
        // An app build that can't open Cashfree's checkout pays through Razorpay.
        expect(
          await resolvePaymentContext({ venueId: inVenue!.id, tenantId, checkoutGateways: new Set() }),
        ).toEqual({ provider: 'razorpay', currency: 'INR' });
        expect(await resolvePaymentContext({ venueId: inVenue!.id, tenantId })).toEqual({
          provider: 'razorpay',
          currency: 'INR',
        });
      } finally {
        if (saved) {
          await db
            .update(platformSettings)
            .set({ value: saved.value })
            .where(sql`key = 'inr_payment_gateway'`);
        } else {
          await db.delete(platformSettings).where(sql`key = 'inr_payment_gateway'`);
        }
        __resetPaymentSettingsCacheForTesting();
        await db.execute(sql`delete from venues where id = ${inVenue!.id}`);
      }
    });
  });

  describe('resolvePaymentContext', () => {
    it('US venue → stripe/USD; Indian venue → razorpay/INR; no country → razorpay/INR', async () => {
      // Assumes no admin INR-gateway choice; the setting test above restores it.
      const [setting] = await db
        .select()
        .from(platformSettings)
        .where(sql`key = 'inr_payment_gateway'`);
      if (setting && setting.value !== 'razorpay') return;
      const [usVenue] = await db
        .insert(venues)
        .values({ tenantId, name: 'US V', tzName: 'America/New_York', country: 'USA' })
        .returning();
      const [inVenue] = await db
        .insert(venues)
        .values({ tenantId, name: 'IN V', tzName: 'Asia/Kolkata', country: 'India' })
        .returning();

      expect(await resolvePaymentContext({ venueId: usVenue!.id, tenantId })).toEqual({
        provider: 'stripe',
        currency: 'USD',
      });
      expect(await resolvePaymentContext({ venueId: inVenue!.id, tenantId })).toEqual({
        provider: 'razorpay',
        currency: 'INR',
      });
      // No venue + tenant without a country → the pre-multi-gateway default.
      expect(await resolvePaymentContext({ tenantId })).toEqual({
        provider: 'razorpay',
        currency: 'INR',
      });

      await db.execute(sql`delete from venues where id in (${usVenue!.id}, ${inVenue!.id})`);
    });
  });

  describe('listForBooking', () => {
    it('returns the payment rows for a booking', async () => {
      const dateIso = '2031-12-06T05:00:00.000Z';
      const { bookingId, paymentId } = await seedPendingBookingWithOrder(dateIso);
      const rows = await listForBooking(bookingId, tenantId);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.some((r) => r.id === paymentId)).toBe(true);
    });

    it("returns nothing when asked under another tenant's id", async () => {
      const dateIso = '2031-12-07T05:00:00.000Z';
      const { bookingId } = await seedPendingBookingWithOrder(dateIso);
      expect(await listForBooking(bookingId, crypto.randomUUID())).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: billing snapshots + advance release (billing-knobs feature)
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('payments_service billing snapshots + advance release', () => {
  let tenantId: string;
  let userId: string;

  async function seedBooking(status: 'pending' | 'cancelled'): Promise<string> {
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status,
        totalPaise: 52233,
        createdByUserId: userId,
      })
      .returning();
    return b!.id;
  }

  /** Order + charge row with the full billing snapshot; returns ids. */
  async function seedOrder(bookingId: string, advancePaise: number) {
    return createPaymentOrder({
      bookingId,
      tenantId,
      amountPaise: 52233,
      settleBasePaise: 49638, // 50000 base − 362 org fee share
      consumerCommissionPaise: 1000,
      partnerCommissionPaise: 2500,
      advancePaise,
      billingMetadata: {
        partnerCommissionBps: 500,
        consumerCommissionBps: 200,
        customerShareBps: 10_000,
        orgShareBps: 3_000,
        advancePayoutBps: 3_000,
        orgFeeSharePaise: 362,
        gatewayFeeEstimatePaise: 1209,
      },
      provider: 'razorpay',
      currency: 'INR',
      actorUserId: userId,
    });
  }

  function captureEvent(orderId: string, eventId: string) {
    return handleRazorpayWebhook({
      event: 'payment.captured',
      eventId,
      payload: {
        payment: {
          entity: { order_id: orderId, id: `pay_${eventId}`, amount: 52233, currency: 'INR' },
        },
      },
    });
  }

  async function chargeRow(paymentId: string) {
    const [row] = await db.select().from(payments).where(sql`id = ${paymentId}::uuid`);
    return row!;
  }

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `paysnap-fb-${Date.now()}`, email: `paysnap-${Date.now()}@test.x` })
      .returning();
    userId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'PaySnap Co', slug: `paysnap-${Date.now()}`, customerFeeShareBps: 10_000 })
      .returning();
    tenantId = t!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${userId}`);
    await closeDb();
  });

  it('createPaymentOrder persists the billing snapshots + metadata rate card', async () => {
    const bookingId = await seedBooking('pending');
    const { paymentId } = await seedOrder(bookingId, 14_141);

    const row = await chargeRow(paymentId);
    expect(Number(row.settleBasePaise)).toBe(49638);
    expect(Number(row.consumerCommissionPaise)).toBe(1000);
    expect(Number(row.partnerCommissionPaise)).toBe(2500);
    expect(Number(row.advancePaise)).toBe(14_141);
    expect(row.advanceReleasedAt).toBeNull(); // not captured yet
    expect((row.metadata as { billing?: Record<string, number> }).billing).toMatchObject({
      orgShareBps: 3_000,
      orgFeeSharePaise: 362,
      gatewayFeeEstimatePaise: 1209,
    });
  });

  it('capture stamps advance_released_at once; replays do not re-stamp', async () => {
    const bookingId = await seedBooking('pending');
    const { paymentId, providerOrderId } = await seedOrder(bookingId, 14_141);

    await captureEvent(providerOrderId, `evt-adv-${Date.now()}`);
    const afterCapture = await chargeRow(paymentId);
    expect(afterCapture.status).toBe('captured');
    expect(afterCapture.advanceReleasedAt).not.toBeNull();

    // Booking confirmed by the normal path.
    const [bk] = await db.select().from(bookings).where(sql`id = ${bookingId}::uuid`);
    expect(bk!.status).toBe('confirmed');

    // Replay with a fresh event id — idempotent, timestamp unchanged.
    await captureEvent(providerOrderId, `evt-adv-replay-${Date.now()}`);
    const afterReplay = await chargeRow(paymentId);
    expect(afterReplay.advanceReleasedAt?.getTime()).toBe(
      afterCapture.advanceReleasedAt?.getTime(),
    );
  });

  it('capture with no advance leaves advance_released_at NULL', async () => {
    const bookingId = await seedBooking('pending');
    const { paymentId, providerOrderId } = await seedOrder(bookingId, 0);

    await captureEvent(providerOrderId, `evt-noadv-${Date.now()}`);
    const row = await chargeRow(paymentId);
    expect(row.status).toBe('captured');
    expect(row.advanceReleasedAt).toBeNull();
  });

  it('captured-after-cancellation auto-refund does NOT release the advance', async () => {
    const bookingId = await seedBooking('cancelled');
    const { paymentId, providerOrderId } = await seedOrder(bookingId, 14_141);

    await captureEvent(providerOrderId, `evt-cancel-${Date.now()}`);
    const row = await chargeRow(paymentId);
    // The capture is recorded and immediately fully refunded…
    expect(row.status).toBe('refunded');
    // …but the advance never became payable.
    expect(row.advanceReleasedAt).toBeNull();

    const [refund] = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingId}::uuid and kind = 'refund'`);
    expect(Number(refund!.amountPaise)).toBe(-52233);
  });
});
