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
  couponRedemptions,
  coupons,
  payments,
  tenants,
  users,
  venues,
} from '../db/schema/index.js';
import { computeSettleRefundPaise, issueRefund } from './refund_service.js';
import { __resetRazorpayForTesting } from '../lib/razorpay.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

// ---------------------------------------------------------------------------
// computeSettleRefundPaise — pure math, always runs.
//
// Fixtures mirror coupon_redemption.test.ts: base 50000, 10% coupon → discount
// 5000, discounted base 45000, customer pays grossUp(45000) = 46088 (fee 1088).
// Without a coupon the customer pays grossUp(50000) = 51209.
// ---------------------------------------------------------------------------
describe('computeSettleRefundPaise', () => {
  it('no coupon: full refund deducts exactly the customer cash', () => {
    expect(
      computeSettleRefundPaise({
        chargeAmountPaise: 51209,
        platformDiscountPaise: 0,
        totalRefundedPaise: 51209,
        priorSettleDeductedPaise: 0,
      }),
    ).toBe(51209);
  });

  it('no coupon: a partial refund deducts the cash amount', () => {
    expect(
      computeSettleRefundPaise({
        chargeAmountPaise: 51209,
        platformDiscountPaise: 0,
        totalRefundedPaise: 20000,
        priorSettleDeductedPaise: 0,
      }),
    ).toBe(20000);
  });

  it('org-funded coupon: no clawback — behaves exactly like no coupon', () => {
    // Org discounts already reduced the partner's settle credit at charge
    // time, so the refund deduction is plain customer cash.
    expect(
      computeSettleRefundPaise({
        chargeAmountPaise: 46088,
        platformDiscountPaise: 0,
        totalRefundedPaise: 46088,
        priorSettleDeductedPaise: 0,
      }),
    ).toBe(46088);
  });

  it('platform-funded coupon: full refund claws back cash + discount (the bug)', () => {
    // 46088 + 5000 = 51088 = settle credit 50000 + fee 1088: the partner nets
    // −fee like any refunded sale, and Circls recovers the discount it fronted.
    expect(
      computeSettleRefundPaise({
        chargeAmountPaise: 46088,
        platformDiscountPaise: 5000,
        totalRefundedPaise: 46088,
        priorSettleDeductedPaise: 0,
      }),
    ).toBe(51088);
  });

  it('platform-funded coupon: partials floor, then top up to exactly D', () => {
    // First partial 10000 of 46088 → floor(10000·51088/46088) = 11084.
    const first = computeSettleRefundPaise({
      chargeAmountPaise: 46088,
      platformDiscountPaise: 5000,
      totalRefundedPaise: 10000,
      priorSettleDeductedPaise: 0,
    });
    expect(first).toBe(11084);
    // Remainder 36088 → deduction tops the total up to exactly 51088.
    const second = computeSettleRefundPaise({
      chargeAmountPaise: 46088,
      platformDiscountPaise: 5000,
      totalRefundedPaise: 46088,
      priorSettleDeductedPaise: first,
    });
    expect(first + second).toBe(51088);
  });

  it('legacy prior refunds (NULL settle → cash fallback) never over-deduct', () => {
    // A legacy partial already deducted its full cash (20000) — more than the
    // prorated target. The next deduction clamps at ≥ 0 and the completed
    // refund still totals exactly D via the remaining-cap.
    const second = computeSettleRefundPaise({
      chargeAmountPaise: 46088,
      platformDiscountPaise: 5000,
      totalRefundedPaise: 46088,
      priorSettleDeductedPaise: 20000,
    });
    expect(second).toBe(31088);
    expect(20000 + second).toBe(51088);
  });

  it('property: every split sequence stays in [0, D] and completes to exactly D', () => {
    const cases = [
      { chargeAmountPaise: 51209, platformDiscountPaise: 0 },
      { chargeAmountPaise: 46088, platformDiscountPaise: 0 },
      { chargeAmountPaise: 46088, platformDiscountPaise: 5000 },
      // Adversarial rounding: tiny charge, large discount.
      { chargeAmountPaise: 7, platformDiscountPaise: 9999 },
    ];
    for (const c of cases) {
      const D = c.chargeAmountPaise + c.platformDiscountPaise;
      for (const firstCut of [1, 2, 3, 999, Math.floor(c.chargeAmountPaise / 3), c.chargeAmountPaise - 1]) {
        if (firstCut < 1 || firstCut >= c.chargeAmountPaise) continue;
        let refunded = 0;
        let deducted = 0;
        for (const step of [firstCut, c.chargeAmountPaise - firstCut]) {
          refunded += step;
          const d = computeSettleRefundPaise({
            ...c,
            totalRefundedPaise: refunded,
            priorSettleDeductedPaise: deducted,
          });
          expect(d).toBeGreaterThanOrEqual(0);
          deducted += d;
          expect(deducted).toBeLessThanOrEqual(D);
        }
        expect(deducted).toBe(D);
      }
    }
  });
});

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
    settleBasePaise?: number;
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
      settleBasePaise: opts.settleBasePaise ?? null,
      currency: 'INR',
      status: 'captured',
      kind: 'charge',
    });
    return b!.id;
  }

  /** Seed a platform coupon + redemption so the booking carries a Circls-funded discount. */
  async function seedPlatformRedemption(bookingId: string, discountPaise: number): Promise<void> {
    const [c] = await db
      .insert(coupons)
      .values({
        ownerType: 'platform',
        code: `RFNDSVC${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        scopeType: 'org',
        discountType: 'percent',
        discountValue: 1000,
      })
      .returning();
    await db.insert(couponRedemptions).values({
      couponId: c!.id,
      bookingId,
      tenantId,
      basePaise: 50000,
      discountPaise,
      funder: 'platform',
    });
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
    await db.execute(sql`delete from coupon_redemptions where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from coupons where code like 'RFNDSVC%'`);
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
    // No coupon → the settle deduction is plain customer cash (never NULL on
    // new rows; NULL is reserved for legacy data).
    expect(Number(rows[1]!.settleBasePaise)).toBe(-50000);
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
    expect(Number(refundRow!.settleBasePaise)).toBe(-20000);
  });

  // Platform-funded coupons: Circls credits the partner the full base but the
  // customer pays the discounted (grossed-up) total. On refund the deduction
  // must also claw back the Circls-funded discount — D = cash + discount —
  // or the partner keeps phantom credit. Fixture: base 50000, 10% coupon,
  // customer pays 46088 → D = 51088.
  it('platform-coupon full refund claws back cash + Circls-funded discount', async () => {
    const bookingId = await seedBookingWithCharge({
      provider: 'stub',
      amountPaise: 46088,
      settleBasePaise: 50000,
    });
    await seedPlatformRedemption(bookingId, 5000);

    await issueRefund({ bookingId, amountPaise: 46088, reason: 'plat full', actorUserId });

    const [refundRow] = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingId} and kind = 'refund'`);
    expect(Number(refundRow!.amountPaise)).toBe(-46088);
    expect(Number(refundRow!.settleBasePaise)).toBe(-51088);
  });

  it('platform-coupon partial refunds sum to exactly the clawback total', async () => {
    const bookingId = await seedBookingWithCharge({
      provider: 'stub',
      amountPaise: 46088,
      settleBasePaise: 50000,
    });
    await seedPlatformRedemption(bookingId, 5000);

    await issueRefund({ bookingId, amountPaise: 10000, reason: 'plat part 1', actorUserId });
    await issueRefund({ bookingId, amountPaise: 36088, reason: 'plat part 2', actorUserId });

    const rows = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingId} and kind = 'refund'`)
      .orderBy(sql`created_at asc`);
    expect(rows).toHaveLength(2);
    // floor(10000·51088/46088) = 11084; the second tops up to exactly −51088.
    expect(Number(rows[0]!.settleBasePaise)).toBe(-11084);
    expect(Number(rows[1]!.settleBasePaise)).toBe(-40004);
    const settleTotal = rows.reduce((s, r) => s + Number(r.settleBasePaise), 0);
    expect(settleTotal).toBe(-51088);
  });

  it('rejects a zero or non-integer refund amount', async () => {
    await expect(
      issueRefund({ bookingId: bookingFullId, amountPaise: 0, reason: 'x', actorUserId }),
    ).rejects.toMatchObject({ code: 'bad_refund_amount' });
    await expect(
      issueRefund({ bookingId: bookingFullId, amountPaise: 12.5, reason: 'x', actorUserId }),
    ).rejects.toMatchObject({ code: 'bad_refund_amount' });
  });

  // M3: two concurrent full-amount refunds against the same charge must NOT
  // both succeed. The FOR UPDATE lock on the charge serializes them, so the
  // second sees the first's refund and is rejected for exceeding remaining.
  it('serializes concurrent refunds (no over-refund)', async () => {
    const bookingId = await seedBookingWithCharge({
      provider: 'razorpay',
      amountPaise: 40000,
      providerPaymentId: 'pay_test_concurrent_1',
    });

    const results = await Promise.allSettled([
      issueRefund({ bookingId, amountPaise: 40000, reason: 'race a', actorUserId }),
      issueRefund({ bookingId, amountPaise: 40000, reason: 'race b', actorUserId }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'refund_exceeds_charge',
    });

    // Exactly one (negative) refund row should exist, and the charge is fully
    // refunded — never over-refunded.
    const refundRows = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingId} and kind = 'refund' and status <> 'failed'`);
    expect(refundRows).toHaveLength(1);
    const totalRefunded = refundRows.reduce((s, r) => s + Math.abs(Number(r.amountPaise)), 0);
    expect(totalRefunded).toBe(40000);
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
