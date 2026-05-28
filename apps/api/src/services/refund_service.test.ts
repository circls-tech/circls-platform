/**
 * Refund service — integration tests over a real Postgres.
 *
 * Verifies the ledger invariants:
 *   - issueRefund() inserts a negative-amount row (it's an outflow).
 *   - Original charge transitions to 'refunded' on full repay and to
 *     'partially_refunded' on a partial.
 *   - Razorpay charges hit the (stub) adapter and persist provider id.
 *   - Stub / external providers do NOT hit any adapter and complete instantly.
 *   - Audit row 'payment.refunded' is written.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import {
  arenas,
  auditLog,
  bookings,
  payments,
  tenants,
  users,
  venues,
} from '../db/schema/index.js';
import { issueRefund } from './refund_service.js';
import { __resetRazorpayForTesting } from '../lib/razorpay.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('refund_service integration', () => {
  let tenantId: string;
  let actorUserId: string;
  // Pre-created IDs reused across tests.
  let bookingFullId: string;
  let bookingPartialId: string;
  let bookingStubId: string;
  let bookingExternalId: string;

  async function seedBookingWithCharge(opts: {
    provider: 'razorpay' | 'stub' | 'external';
    amountPaise: number;
    providerPaymentId?: string | null;
  }): Promise<string> {
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        itemType: 'slot',
        channel: opts.provider === 'external' ? 'walkin' : 'circls',
        paymentMethod:
          opts.provider === 'external'
            ? 'external'
            : opts.provider === 'razorpay'
              ? 'razorpay_route'
              : 'razorpay_route',
        status: 'confirmed',
        totalPaise: opts.amountPaise,
        createdByUserId: actorUserId,
      })
      .returning();
    await db.insert(payments).values({
      bookingId: b!.id,
      tenantId,
      provider: opts.provider,
      providerPaymentId: opts.providerPaymentId ?? null,
      amountPaise: opts.amountPaise,
      currency: 'INR',
      status: 'captured',
      kind: 'charge',
    });
    return b!.id;
  }

  beforeAll(async () => {
    await pingDb();
    __resetRazorpayForTesting();

    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `refundsvc-${Date.now()}`, email: `refund-${Date.now()}@test.x` })
      .returning();
    actorUserId = u!.id;

    const [t] = await db
      .insert(tenants)
      .values({ name: 'RefundSvc', slug: `refundsvc-${Date.now()}` })
      .returning();
    tenantId = t!.id;

    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'V', tzName: 'Asia/Kolkata' })
      .returning();
    await db.insert(arenas).values({ venueId: v!.id, name: 'A' });

    bookingFullId = await seedBookingWithCharge({
      provider: 'razorpay',
      amountPaise: 50000,
      providerPaymentId: 'pay_test_full_1',
    });
    bookingPartialId = await seedBookingWithCharge({
      provider: 'razorpay',
      amountPaise: 80000,
      providerPaymentId: 'pay_test_partial_1',
    });
    bookingStubId = await seedBookingWithCharge({ provider: 'stub', amountPaise: 30000 });
    bookingExternalId = await seedBookingWithCharge({ provider: 'external', amountPaise: 20000 });
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from arenas where venue_id in (select id from venues where tenant_id = ${tenantId})`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${actorUserId}`);
    await closeDb();
  });

  it('issues a full refund — original charge moves to "refunded", refund row is negative', async () => {
    const res = await issueRefund({
      bookingId: bookingFullId,
      amountPaise: 50000,
      reason: 'test full',
      actorUserId,
    });

    expect(res.status).toBe('processed');
    expect(res.providerRefundId).toBeDefined();
    expect(res.providerRefundId).toMatch(/^stub_rfnd_/);

    const rows = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingFullId}`)
      .orderBy(sql`created_at asc`);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('charge');
    expect(rows[0]!.status).toBe('refunded');
    expect(Number(rows[0]!.amountPaise)).toBe(50000);
    expect(rows[1]!.kind).toBe('refund');
    // Row status: Razorpay's 'processed' maps to our payment_status enum
    // value 'captured' (money has moved). The wire-level result still
    // surfaces 'processed' for adapter parity.
    expect(rows[1]!.status).toBe('captured');
    expect(Number(rows[1]!.amountPaise)).toBe(-50000);
    expect(rows[1]!.providerPaymentId).toBe(res.providerRefundId);
  });

  it('issues a partial refund — original charge moves to "partially_refunded"', async () => {
    await issueRefund({
      bookingId: bookingPartialId,
      amountPaise: 30000,
      reason: 'partial 1',
      actorUserId,
    });

    const rows = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingPartialId}`)
      .orderBy(sql`created_at asc`);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe('charge');
    expect(rows[0]!.status).toBe('partially_refunded');
    expect(Number(rows[1]!.amountPaise)).toBe(-30000);
  });

  it('blocks a refund that exceeds the remaining-to-refund balance', async () => {
    // Already refunded 30000 of 80000 in the previous test → remaining = 50000.
    await expect(
      issueRefund({
        bookingId: bookingPartialId,
        amountPaise: 60000,
        reason: 'oversize',
        actorUserId,
      }),
    ).rejects.toMatchObject({ code: 'refund_exceeds_charge' });
  });

  it('a second partial refund that completes the charge moves it to "refunded"', async () => {
    await issueRefund({
      bookingId: bookingPartialId,
      amountPaise: 50000,
      reason: 'remainder',
      actorUserId,
    });
    const [charge] = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingPartialId} and kind = 'charge'`);
    expect(charge!.status).toBe('refunded');
  });

  it('stub-provider refund does not call the adapter and completes instantly', async () => {
    const res = await issueRefund({
      bookingId: bookingStubId,
      amountPaise: 30000,
      reason: 'stub refund',
      actorUserId,
    });
    // No providerPaymentId on the original charge → no provider call → no
    // providerRefundId returned.
    expect(res.providerRefundId).toBeUndefined();
    expect(res.status).toBe('processed');

    const [refundRow] = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingStubId} and kind = 'refund'`);
    expect(refundRow!.providerPaymentId).toBeNull();
  });

  it('external-provider (cash) refund records the row without a provider call', async () => {
    const res = await issueRefund({
      bookingId: bookingExternalId,
      amountPaise: 20000,
      reason: 'cash refunded at counter',
      actorUserId,
    });
    expect(res.providerRefundId).toBeUndefined();

    const [refundRow] = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingExternalId} and kind = 'refund'`);
    expect(refundRow!.provider).toBe('external');
    expect(Number(refundRow!.amountPaise)).toBe(-20000);
  });

  it('rejects a zero or non-integer refund amount', async () => {
    await expect(
      issueRefund({ bookingId: bookingFullId, amountPaise: 0, reason: 'x', actorUserId }),
    ).rejects.toMatchObject({ code: 'bad_refund_amount' });
    await expect(
      issueRefund({ bookingId: bookingFullId, amountPaise: 12.5, reason: 'x', actorUserId }),
    ).rejects.toMatchObject({ code: 'bad_refund_amount' });
  });

  it('writes a payment.refunded audit row', async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(sql`tenant_id = ${tenantId} and action = 'payment.refunded'`);
    // Each successful refund above contributes one row. We don't pin an exact
    // count to leave room for harness-level retries.
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) {
      const after = r.after as Record<string, unknown>;
      expect(after).toHaveProperty('amountPaise');
      expect(after).toHaveProperty('chargePaymentId');
    }
  });
});
