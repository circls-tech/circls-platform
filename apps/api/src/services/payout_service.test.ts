/**
 * Payout service tests.
 *
 *  - priorWeek(): pure date math, always runs.
 *  - computeCommissionPaise(): policy invariants — SKIPPED until the TODO(human)
 *    body lands. Un-skip the describe block once it's implemented.
 *  - executePayout / listPayouts / reconcileWeeklyPayouts: integration
 *    (needs RUN_INTEGRATION + a DB).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { bookings, payouts, tenants, users, venues } from '../db/schema/index.js';
import { computeCommissionPaise, priorWeek, reconcileWeeklyPayouts } from './payout_service.js';

describe('priorWeek', () => {
  it('returns the previous Mon→Mon window for a mid-week date', () => {
    // 2026-05-29 is a Friday. This week's Monday is 05-25; prior week 05-18.
    const { start, end } = priorWeek(new Date('2026-05-29T09:30:00Z'));
    expect(start.toISOString()).toBe('2026-05-18T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-25T00:00:00.000Z');
  });

  it('on a Monday, settles the week that just ended', () => {
    const { start, end } = priorWeek(new Date('2026-05-25T03:00:00Z'));
    expect(start.toISOString()).toBe('2026-05-18T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-05-25T00:00:00.000Z');
  });

  it('produces a 7-day window', () => {
    const { start, end } = priorWeek(new Date('2026-01-01T12:00:00Z'));
    expect((end.getTime() - start.getTime()) / 86_400_000).toBe(7);
  });
});

// Policy-agnostic invariants — they hold for commission-on-gross or
// commission-on-net, and for floor/round/ceil rounding.
describe('computeCommissionPaise — invariants', () => {
  it('is zero when the rate is zero', () => {
    expect(computeCommissionPaise(100_000, 0, 0)).toBe(0);
  });

  it('returns a non-negative integer', () => {
    const c = computeCommissionPaise(123_457, 1_111, 750);
    expect(Number.isInteger(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(0);
  });

  it('never exceeds the gross', () => {
    expect(computeCommissionPaise(100_000, 0, 10_000)).toBeLessThanOrEqual(100_000);
  });

  it('charges more as the rate rises', () => {
    const lo = computeCommissionPaise(100_000, 0, 200);
    const hi = computeCommissionPaise(100_000, 0, 800);
    expect(hi).toBeGreaterThan(lo);
  });

  it('takes a real cut on a non-zero rate', () => {
    expect(computeCommissionPaise(100_000, 0, 500)).toBeGreaterThan(0);
  });
});

// Pins the chosen policy: commission on GROSS, floored.
describe('computeCommissionPaise — commission-on-gross, floored', () => {
  it('charges the rate on gross (5% of ₹1000 = ₹50)', () => {
    expect(computeCommissionPaise(100_000, 0, 500)).toBe(5_000);
  });

  it('floors the sub-paise remainder (2.5% of 12345p = 308p, not 308.625)', () => {
    expect(computeCommissionPaise(12_345, 0, 250)).toBe(308);
  });

  it('ignores refunds when sizing the cut (still 5% of gross)', () => {
    // gross 100000, refunds 40000 → commission stays 5000, not 5% of 60000.
    expect(computeCommissionPaise(100_000, 40_000, 500)).toBe(5_000);
  });

  it('clamps so commission never pushes net below zero', () => {
    // 100% of gross but ₹9 already refunded → cut capped at the ₹1 left.
    expect(computeCommissionPaise(1_000, 900, 10_000)).toBe(100);
  });
});

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

// ---------------------------------------------------------------------------
// Integration: reconcileWeeklyPayouts — settle_base_paise preference
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('reconcileWeeklyPayouts integration', () => {
  let tenantId: string;
  let bookingId: string;
  let userId: string;
  const extraTenantIds: string[] = [];

  // Use 2026-05-29 (Friday) as "now"; priorWeek → [2026-05-18, 2026-05-25).
  const NOW = new Date('2026-05-29T09:30:00Z');
  // A settlement_released_at within that prior week.
  const RELEASED_IN_WINDOW = '2026-05-20T10:00:00.000Z';

  beforeAll(async () => {
    await pingDb();

    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `payout-fb-${Date.now()}`, email: `payout-${Date.now()}@test.x` })
      .returning();
    userId = u!.id;

    const [t] = await db
      .insert(tenants)
      .values({ name: 'Payout Co', slug: `payoutco-${Date.now()}`, commissionBps: 0 })
      .returning();
    tenantId = t!.id;

    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'V', tzName: 'Asia/Kolkata' })
      .returning();

    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId: v!.id,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        customerName: 'Payout Test',
        customerContact: '+91-9000000999',
        totalPaise: 46088,
        createdByUserId: userId,
      })
      .returning();
    bookingId = b!.id;
  });

  afterAll(async () => {
    for (const tid of [tenantId, ...extraTenantIds]) {
      await db.execute(sql`delete from payouts where tenant_id = ${tid}`);
      await db.execute(sql`delete from payments where tenant_id = ${tid}`);
      await db.execute(sql`delete from bookings where tenant_id = ${tid}`);
      await db.execute(sql`delete from venues where tenant_id = ${tid}`);
      await db.execute(sql`delete from tenants where id = ${tid}`);
    }
    await db.execute(sql`delete from users where id = ${userId}`);
    await closeDb();
  });

  /**
   * Seed an isolated tenant with, all inside the settlement window:
   *  - a refunded platform-coupon charge (customer paid 46088, settle 50000),
   *  - a plain captured charge (100000) so net stays positive,
   *  - one refund row whose settle_base_paise the test controls.
   */
  async function seedTenantWithRefund(refundSettlePaise: number | null): Promise<string> {
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Payout Refund Co', slug: `payoutrfnd-${Date.now()}-${extraTenantIds.length}`, commissionBps: 0 })
      .returning();
    extraTenantIds.push(t!.id);

    const [b] = await db
      .insert(bookings)
      .values({
        tenantId: t!.id,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        totalPaise: 146088,
        createdByUserId: userId,
      })
      .returning();

    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, amount_paise, settle_base_paise,
        status, kind, settlement_released_at, created_at
      ) values
      (${b!.id}::uuid, ${t!.id}::uuid, 'stub', 46088, 50000,
       'refunded', 'charge', ${RELEASED_IN_WINDOW}::timestamptz, ${RELEASED_IN_WINDOW}::timestamptz),
      (${b!.id}::uuid, ${t!.id}::uuid, 'stub', 100000, null,
       'captured', 'charge', ${RELEASED_IN_WINDOW}::timestamptz, ${RELEASED_IN_WINDOW}::timestamptz),
      (${b!.id}::uuid, ${t!.id}::uuid, 'stub', -46088, ${refundSettlePaise},
       'captured', 'refund', null, ${RELEASED_IN_WINDOW}::timestamptz)
    `);
    return t!.id;
  }

  it('prefers settle_base_paise over amount_paise for gross', async () => {
    // Seed a captured charge: grossed-up amount 46088, settleable base 50000.
    // settlement_released_at is inside the prior-week window for NOW.
    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, provider_payment_id,
        amount_paise, settle_base_paise,
        status, kind, settlement_released_at
      ) values (
        ${bookingId}::uuid, ${tenantId}::uuid, 'stub', 'pay_settle_base_test',
        46088, 50000,
        'captured', 'charge', ${RELEASED_IN_WINDOW}::timestamptz
      )
    `);

    const count = await reconcileWeeklyPayouts(NOW);
    expect(count).toBe(1);

    const [row] = await db
      .select()
      .from(payouts)
      .where(sql`tenant_id = ${tenantId}::uuid`);

    // gross must reflect settle_base_paise (50000), not amount_paise (46088).
    expect(row?.grossPaise).toBe(50000);
  });

  it('deducts refunds at settle value — Circls-funded discount clawback included', async () => {
    // Refund row carries settle −51088 (cash 46088 + platform discount 5000).
    const tid = await seedTenantWithRefund(-51088);

    await reconcileWeeklyPayouts(NOW);

    const [row] = await db.select().from(payouts).where(sql`tenant_id = ${tid}::uuid`);
    expect(row?.grossPaise).toBe(150000); // 50000 settle + 100000 plain
    expect(row?.refundsPaise).toBe(51088); // NOT the 46088 customer cash
    expect(row?.amountPaise).toBe(98912); // gross − refunds, commission 0
  });

  it('legacy refund rows (NULL settle) still deduct customer cash', async () => {
    const tid = await seedTenantWithRefund(null);

    await reconcileWeeklyPayouts(NOW);

    const [row] = await db.select().from(payouts).where(sql`tenant_id = ${tid}::uuid`);
    expect(row?.refundsPaise).toBe(46088);
    expect(row?.amountPaise).toBe(103912);
  });
});
