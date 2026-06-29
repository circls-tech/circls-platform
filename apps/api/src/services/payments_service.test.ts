import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import {
  arenas,
  auditLog,
  bookings,
  payments,
  slots,
  tenants,
  users,
  venues,
} from '../db/schema/index.js';
import { __resetRazorpayForTesting } from '../lib/razorpay.js';
import { createPricingRule } from './pricing_service.js';
import {
  createRouteOrder,
  handleRazorpayWebhook,
  listForBooking,
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
    await closeDb();
  });

  /** Create a fresh pending booking + payment row scoped to a far-future slot. */
  async function seedPendingBookingWithOrder(dateIso: string): Promise<{
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
    const order = await createRouteOrder({
      bookingId: booking!.id,
      tenantId,
      amountPaise: 50000,
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

  describe('createRouteOrder', () => {
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
    it('flips payment to failed and cancels the pending booking', async () => {
      const dateIso = '2031-10-04T05:00:00.000Z';
      const { bookingId, orderId, paymentId } = await seedPendingBookingWithOrder(dateIso);

      await handleRazorpayWebhook({
        event: 'payment.failed',
        eventId: 'evt_fail_1',
        payload: { payment: { entity: { order_id: orderId, id: 'pay_stub_x' } } },
      });

      const [pay] = await db.select().from(payments).where(sql`id = ${paymentId}`);
      expect(pay?.status).toBe('failed');

      const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(book?.status).toBe('cancelled');
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

  describe('listForBooking', () => {
    it('returns the payment rows for a booking', async () => {
      const dateIso = '2031-12-06T05:00:00.000Z';
      const { bookingId, paymentId } = await seedPendingBookingWithOrder(dateIso);
      const rows = await listForBooking(bookingId);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.some((r) => r.id === paymentId)).toBe(true);
    });
  });
});
