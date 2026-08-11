/**
 * Payments service — integration tests over a real Postgres (stub gateway).
 *
 * Covers the billing-snapshot persistence and the capture webhook core:
 *   - createPaymentOrder() persists the per-charge billing snapshots
 *     (consumer/partner commission, advance) and the metadata rate card.
 *   - payment.captured stamps advance_released_at exactly once (webhook
 *     replays don't re-stamp), and only when there IS an advance.
 *   - The captured-after-cancellation auto-refund branch does NOT release
 *     the advance (paying and clawing back in one week would only churn
 *     the payout ledger).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { bookings, payments, tenants, users } from '../db/schema/index.js';
import { createPaymentOrder, handleRazorpayWebhook } from './payments_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('payments_service integration', () => {
  let tenantId: string;
  let userId: string;
  const bookingIds: string[] = [];

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
    bookingIds.push(b!.id);
    return b!.id;
  }

  /** Order + charge row with the full billing snapshot; returns ids. */
  async function seedOrder(bookingId: string, advancePaise: number) {
    const order = await createPaymentOrder({
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
    return order;
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
      .values({ firebaseUid: `paysvc-fb-${Date.now()}`, email: `paysvc-${Date.now()}@test.x` })
      .returning();
    userId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'PaySvc Co', slug: `paysvc-${Date.now()}` })
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
