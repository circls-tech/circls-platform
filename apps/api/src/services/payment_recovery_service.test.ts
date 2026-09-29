import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { bookings, payments, tenants, users } from '../db/schema/index.js';
import { __resetCashfreeForTesting, getCashfree } from '../lib/cashfree.js';
import { GatewayHttpError } from '../lib/gateway_http.js';
import { getRazorpay } from '../lib/razorpay.js';
import type { GatewayOrderStatus, GatewayRefundResult, PaymentGateway } from '../lib/gateway.js';
import {
  reconcileCashfreePayments,
  switchCheckoutGateway,
  verifyCheckoutPayment,
} from './payment_recovery_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

/** The Cashfree adapter, with the lookups it implements typed as present. */
const cashfree = () => getCashfree() as Required<PaymentGateway>;

describe.skipIf(!runIntegration)('payment_recovery_service', () => {
  let tenantId: string;
  let customerId: string;
  let strangerId: string;
  const stamp = Date.now();
  let seq = 0;

  /** What the faked Cashfree API reports, by order id / refund key. */
  let orderStatus: Record<string, GatewayOrderStatus> = {};
  let refundStatus: Record<string, GatewayRefundResult['status']> = {};
  let cancelled: string[] = [];

  /** Turn the cached (stub) Cashfree adapter into a scripted "live" one. */
  function scriptCashfree(): void {
    const gw = cashfree();
    (gw as unknown as { mode: string }).mode = 'live';
    vi.spyOn(gw, 'fetchOrderStatus').mockImplementation(
      async (orderId: string) => orderStatus[orderId] ?? { state: 'open' },
    );
    vi.spyOn(gw, 'fetchRefundStatus').mockImplementation(async ({ refundId }) => ({
      id: `cfr-${refundId}`,
      status: refundStatus[refundId] ?? 'pending',
      amountMinor: 0,
    }));
    vi.spyOn(gw, 'cancelOrder').mockImplementation(async (orderId: string) => {
      cancelled.push(orderId);
    });
  }

  async function seedCheckout(opts: {
    provider?: 'cashfree' | 'razorpay';
    chargeStatus?: 'pending' | 'failed' | 'captured';
    bookingStatus?: 'pending' | 'confirmed' | 'cancelled';
    createdMinutesAgo?: number;
  } = {}): Promise<{ bookingId: string; chargeId: string; orderId: string }> {
    const orderId = `cf-rec-${stamp}-${++seq}`;
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: opts.bookingStatus ?? 'pending',
        totalPaise: 30000,
        customerUserId: customerId,
        createdByUserId: customerId,
      })
      .returning();
    const [c] = await db
      .insert(payments)
      .values({
        bookingId: b!.id,
        tenantId,
        provider: opts.provider ?? 'cashfree',
        providerOrderId: orderId,
        amountPaise: 30000,
        settleBasePaise: 28000,
        partnerCommissionPaise: 600,
        currency: 'INR',
        status: opts.chargeStatus ?? 'pending',
        kind: 'charge',
        metadata: { billing: { consumerCommissionBps: 0, customerShareBps: 10000, orgShareBps: 0 } },
        createdAt: new Date(Date.now() - (opts.createdMinutesAgo ?? 1) * 60_000),
      })
      .returning();
    return { bookingId: b!.id, chargeId: c!.id, orderId };
  }

  const paidAt = (amountMinor = 30000): GatewayOrderStatus => ({
    state: 'paid',
    payment: { id: `cfpay-${stamp}-${++seq}`, amountMinor, currency: 'INR' },
  });

  beforeAll(async () => {
    await pingDb();
    __resetCashfreeForTesting();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `rec-cust-${stamp}`, email: `rec-cust-${stamp}@test.x` })
      .returning();
    customerId = u!.id;
    const [x] = await db
      .insert(users)
      .values({ firebaseUid: `rec-other-${stamp}`, email: `rec-other-${stamp}@test.x` })
      .returning();
    strangerId = x!.id;
    const [t] = await db.insert(tenants).values({ name: 'Recovery Co', slug: `recovery-${stamp}` }).returning();
    tenantId = t!.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetCashfreeForTesting();
    orderStatus = {};
    refundStatus = {};
    cancelled = [];
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from qr_tickets where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id in (${customerId}, ${strangerId})`);
    await closeDb();
  });

  describe('verifyCheckoutPayment', () => {
    it('asks Cashfree and confirms a payment the webhook has not delivered', async () => {
      scriptCashfree();
      const { bookingId, chargeId, orderId } = await seedCheckout();
      orderStatus[orderId] = paidAt();
      await expect(verifyCheckoutPayment({ userId: customerId, orderId })).resolves.toEqual({
        status: 'paid',
      });
      const [charge] = await db.select().from(payments).where(sql`id = ${chargeId}`);
      expect(charge!.status).toBe('captured');
      const [booking] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
      expect(booking!.status).toBe('confirmed');
    });

    it('reports pending while Cashfree still has the order open', async () => {
      scriptCashfree();
      const { orderId } = await seedCheckout();
      await expect(verifyCheckoutPayment({ userId: customerId, orderId })).resolves.toEqual({
        status: 'pending',
      });
    });

    it('reports a declined attempt, which the customer can retry', async () => {
      scriptCashfree();
      const { chargeId, orderId } = await seedCheckout();
      orderStatus[orderId] = { state: 'open', lastAttempt: 'failed' };
      await expect(verifyCheckoutPayment({ userId: customerId, orderId })).resolves.toEqual({
        status: 'failed',
      });
      // A declined attempt doesn't end the checkout.
      const [charge] = await db.select().from(payments).where(sql`id = ${chargeId}`);
      expect(charge!.status).toBe('pending');

      // One still in flight (a UPI request awaiting approval) is "processing":
      // the checkout must not offer another way to pay.
      orderStatus[orderId] = { state: 'open', lastAttempt: 'pending' };
      await expect(verifyCheckoutPayment({ userId: customerId, orderId })).resolves.toEqual({
        status: 'processing',
      });
    });

    it('a cancelled or replaced checkout is expired', async () => {
      scriptCashfree();
      const cancelled = await seedCheckout({ chargeStatus: 'failed', bookingStatus: 'cancelled' });
      await expect(
        verifyCheckoutPayment({ userId: customerId, orderId: cancelled.orderId }),
      ).resolves.toEqual({ status: 'expired' });

      // Switched to Razorpay: the old Cashfree order is retired.
      const switched = await seedCheckout({ chargeStatus: 'failed' });
      await expect(
        verifyCheckoutPayment({ userId: customerId, orderId: switched.orderId }),
      ).resolves.toEqual({ status: 'expired' });

      // Cashfree already closed the order (e.g. it expired there first).
      const closed = await seedCheckout();
      orderStatus[closed.orderId] = { state: 'closed' };
      await expect(
        verifyCheckoutPayment({ userId: customerId, orderId: closed.orderId }),
      ).resolves.toEqual({ status: 'expired' });
    });

    it('a Cashfree outage reads as pending, not failed', async () => {
      scriptCashfree();
      const { orderId } = await seedCheckout();
      vi.spyOn(cashfree(), 'fetchOrderStatus').mockRejectedValue(new Error('Cashfree timed out'));
      await expect(verifyCheckoutPayment({ userId: customerId, orderId })).resolves.toEqual({
        status: 'pending',
      });
    });

    it("never shows one customer another's payment", async () => {
      const { orderId } = await seedCheckout();
      await expect(verifyCheckoutPayment({ userId: strangerId, orderId })).rejects.toMatchObject({
        code: 'payment_not_found',
      });
    });
  });

  describe('switchCheckoutGateway', () => {
    it('retires the Cashfree order and mints a Razorpay one for the same money', async () => {
      scriptCashfree();
      const { bookingId, chargeId, orderId } = await seedCheckout();
      const result = await switchCheckoutGateway({ userId: customerId, orderId });
      expect(result.outcome).toBe('switched');
      if (result.outcome !== 'switched') return;
      expect(result.payment.gateway).toBe('razorpay');
      expect(result.payment.orderId).toMatch(/^stub_order_/);
      expect(result.payment.amountPaise).toBe(30000);
      expect(cancelled).toEqual([orderId]);

      const [old] = await db.select().from(payments).where(sql`id = ${chargeId}`);
      expect(old!.status).toBe('failed');
      expect(old!.metadata['switchedTo']).toBe('razorpay');
      const [fresh] = await db
        .select()
        .from(payments)
        .where(sql`booking_id = ${bookingId} and id <> ${chargeId}`);
      expect(fresh!.status).toBe('pending');
      expect(Number(fresh!.amountPaise)).toBe(30000);
      expect(Number(fresh!.settleBasePaise)).toBe(28000);
      expect(Number(fresh!.partnerCommissionPaise)).toBe(600);
      expect(fresh!.metadata['billing']).toEqual(old!.metadata['billing']);
    });

    it('tells a customer who already paid instead of charging them again', async () => {
      scriptCashfree();
      const { bookingId, orderId } = await seedCheckout();
      orderStatus[orderId] = paidAt();
      await expect(switchCheckoutGateway({ userId: customerId, orderId })).resolves.toEqual({
        outcome: 'paid',
      });
      const rows = await db.select().from(payments).where(sql`booking_id = ${bookingId}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('captured');
    });

    it('refuses while a payment is still being processed', async () => {
      scriptCashfree();
      const { chargeId, orderId } = await seedCheckout();
      orderStatus[orderId] = { state: 'open', lastAttempt: 'pending' };
      await expect(switchCheckoutGateway({ userId: customerId, orderId })).rejects.toMatchObject({
        code: 'payment_in_progress',
      });
      const [charge] = await db.select().from(payments).where(sql`id = ${chargeId}`);
      expect(charge!.status).toBe('pending');
      expect(cancelled).toEqual([]);
    });

    it('leaves the Cashfree checkout untouched when Razorpay fails', async () => {
      scriptCashfree();
      const { bookingId, chargeId, orderId } = await seedCheckout();
      const spy = vi
        .spyOn(getRazorpay(), 'createOrder')
        .mockRejectedValueOnce(new GatewayHttpError('Razorpay /orders failed (503): down', 'razorpay', 503, true));
      await expect(switchCheckoutGateway({ userId: customerId, orderId })).rejects.toThrow(/503/);
      spy.mockRestore();

      // Nothing retired or terminated: "Try again" on Cashfree still works,
      // and so does a second switch.
      const [charge] = await db.select().from(payments).where(sql`id = ${chargeId}`);
      expect(charge!.status).toBe('pending');
      expect(cancelled).toEqual([]);
      const retry = await switchCheckoutGateway({ userId: customerId, orderId });
      expect(retry.outcome).toBe('switched');
      expect(cancelled).toEqual([orderId]);
      const live = await db
        .select()
        .from(payments)
        .where(sql`booking_id = ${bookingId} and kind = 'charge' and status = 'pending'`);
      expect(live).toHaveLength(1);
      expect(live[0]!.provider).not.toBe('cashfree');
    });

    it('only switches Cashfree checkouts', async () => {
      const { orderId } = await seedCheckout({ provider: 'razorpay' });
      await expect(switchCheckoutGateway({ userId: customerId, orderId })).rejects.toMatchObject({
        code: 'gateway_switch_unavailable',
      });
    });
  });

  describe('reconcileCashfreePayments', () => {
    it('is a no-op while Cashfree is not live', async () => {
      await expect(reconcileCashfreePayments()).resolves.toEqual({ captured: 0, refundsResolved: 0 });
    });

    it('confirms a stale pending payment and refunds a late duplicate', async () => {
      scriptCashfree();
      // A checkout whose webhook never came.
      const stale = await seedCheckout({ createdMinutesAgo: 10 });
      orderStatus[stale.orderId] = paidAt();

      // A booking paid on Razorpay after a switch, whose abandoned Cashfree
      // order was paid too, late.
      const switched = await seedCheckout({ chargeStatus: 'failed', bookingStatus: 'confirmed' });
      await db.insert(payments).values({
        bookingId: switched.bookingId,
        tenantId,
        provider: 'razorpay',
        providerOrderId: `order_rec_${stamp}`,
        providerPaymentId: `pay_rec_${stamp}`,
        amountPaise: 30000,
        currency: 'INR',
        status: 'captured',
        kind: 'charge',
      });
      orderStatus[switched.orderId] = paidAt();

      const result = await reconcileCashfreePayments();
      expect(result.captured).toBe(2);

      const [booking] = await db.select().from(bookings).where(sql`id = ${stale.bookingId}`);
      expect(booking!.status).toBe('confirmed');
      const [dup] = await db.select().from(payments).where(sql`id = ${switched.chargeId}`);
      expect(dup!.status).toBe('refunded');
    });

    it('gets to a pending charge even when a batch of failed rechecks is due', async () => {
      scriptCashfree();
      // 50 failed charges due for a recheck, all older than the pending one.
      const { bookingId: old } = await seedCheckout({ chargeStatus: 'failed', createdMinutesAgo: 120 });
      await db.insert(payments).values(
        Array.from({ length: 50 }, (_, i) => ({
          bookingId: old,
          tenantId,
          provider: 'cashfree' as const,
          providerOrderId: `cf-rec-${stamp}-old-${i}`,
          amountPaise: 30000,
          currency: 'INR',
          status: 'failed' as const,
          kind: 'charge' as const,
          createdAt: new Date(Date.now() - (119 - i / 100) * 60_000),
        })),
      );
      // A paid checkout whose webhook never came.
      const fresh = await seedCheckout({ createdMinutesAgo: 10 });
      orderStatus[fresh.orderId] = paidAt();

      await reconcileCashfreePayments();
      const [booking] = await db.select().from(bookings).where(sql`id = ${fresh.bookingId}`);
      expect(booking!.status).toBe('confirmed');
    });

    it('pushes back a failed charge whose check errors, instead of retrying it every run', async () => {
      scriptCashfree();
      const { chargeId, orderId } = await seedCheckout({ chargeStatus: 'failed', createdMinutesAgo: 60 });
      vi.spyOn(cashfree(), 'fetchOrderStatus').mockImplementation(async (id: string) => {
        if (id === orderId) throw new GatewayHttpError('Cashfree /orders failed (404): gone', 'cashfree', 404, false);
        return { state: 'open' };
      });
      await reconcileCashfreePayments();
      const [charge] = await db.select().from(payments).where(sql`id = ${chargeId}`);
      expect(typeof charge!.metadata['reconciledAt']).toBe('string');
    });

    it('settles a pending refund Cashfree never sent a webhook for', async () => {
      scriptCashfree();
      const { bookingId, chargeId } = await seedCheckout({ chargeStatus: 'captured', bookingStatus: 'confirmed' });
      const key = `rkey${stamp}`;
      const [refund] = await db
        .insert(payments)
        .values({
          bookingId,
          tenantId,
          provider: 'cashfree',
          providerPaymentId: `cfrefund-${stamp}`,
          amountPaise: -30000,
          currency: 'INR',
          status: 'pending',
          kind: 'refund',
          metadata: { chargePaymentId: chargeId, refundKey: key },
          createdAt: new Date(Date.now() - 10 * 60_000),
        })
        .returning();
      refundStatus[key] = 'processed';

      const result = await reconcileCashfreePayments();
      expect(result.refundsResolved).toBe(1);
      const [row] = await db.select().from(payments).where(sql`id = ${refund!.id}`);
      expect(row!.status).toBe('captured');
    });
  });
});
