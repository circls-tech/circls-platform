/**
 * Payout service tests.
 *
 *  - priorWeek(): pure date math, always runs.
 *  - clampCommissionPaise(): clamp invariants (the commission itself is now a
 *    per-payment snapshot; see reconcileWeeklyPayouts).
 *  - executePayout / listPayouts / reconcileWeeklyPayouts: integration
 *    (needs RUN_INTEGRATION + a DB).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { bookings, payouts, tenants, users, venues } from '../db/schema/index.js';
import { clampCommissionPaise, priorWeek, reconcileWeeklyPayouts,
  getPayoutBreakdown,
} from './payout_service.js';

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

// The week-level clamp: raw commission (Σ per-payment snapshots/fallbacks)
// can never push net below zero, and never goes negative itself.
describe('clampCommissionPaise', () => {
  it('passes a raw commission through when there is room', () => {
    expect(clampCommissionPaise(100_000, 0, 5_000)).toBe(5_000);
  });

  it('ignores refunds when they leave room (commission-on-gross policy)', () => {
    // gross 100000, refunds 40000, raw 5000 → 5000, not 5% of 60000.
    expect(clampCommissionPaise(100_000, 40_000, 5_000)).toBe(5_000);
  });

  it('clamps so commission never pushes net below zero', () => {
    // Raw cut of the full gross but ₹9 already refunded → capped at the ₹1 left.
    expect(clampCommissionPaise(1_000, 900, 1_000)).toBe(100);
  });

  it('never goes negative even when refunds exceed gross', () => {
    expect(clampCommissionPaise(1_000, 2_000, 500)).toBe(0);
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

  /** A fresh tenant (optionally with a commission_bps) + a synthetic booking. */
  async function seedTenant(name: string, commissionBps = 0): Promise<{ tid: string; bid: string }> {
    const [t] = await db
      .insert(tenants)
      .values({
        name,
        slug: `payoutadv-${Date.now()}-${extraTenantIds.length}`,
        commissionBps,
      })
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
        totalPaise: 51209,
        createdByUserId: userId,
      })
      .returning();
    return { tid: t!.id, bid: b!.id };
  }

  it('per-payment commission snapshots are summed; legacy NULL rows fall back to tenant bps', async () => {
    // Tenant rate 5% — but the snapshot row carries 1000 (a per-event 2%
    // override captured at charge time), which must win over the tenant rate.
    const { tid, bid } = await seedTenant('Commission Snapshot Co', 500);
    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, amount_paise, settle_base_paise,
        partner_commission_paise, status, kind, settlement_released_at
      ) values
      (${bid}::uuid, ${tid}::uuid, 'stub', 51209, 50000, 1000,
       'captured', 'charge', ${RELEASED_IN_WINDOW}::timestamptz),
      (${bid}::uuid, ${tid}::uuid, 'stub', 102418, 100000, null,
       'captured', 'charge', ${RELEASED_IN_WINDOW}::timestamptz)
    `);

    await reconcileWeeklyPayouts(NOW);

    const [row] = await db.select().from(payouts).where(sql`tenant_id = ${tid}::uuid`);
    // snapshot 1000 + legacy fallback floor(100000 × 500/10000) = 5000.
    expect(row?.grossPaise).toBe(150000);
    expect(row?.commissionPaise).toBe(6000);
    expect(row?.amountPaise).toBe(144000);
  });

  it('an advance released this week pays out before the settlement hold releases', async () => {
    const { tid, bid } = await seedTenant('Advance Only Co');
    // Captured in-window with a 30% advance, but still under settlement hold
    // (settlement_released_at NULL).
    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, amount_paise, settle_base_paise,
        advance_paise, advance_released_at, settlement_hold_until, status, kind
      ) values
      (${bid}::uuid, ${tid}::uuid, 'stub', 51209, 50000,
       15000, ${RELEASED_IN_WINDOW}::timestamptz, '2026-06-10T00:00:00Z'::timestamptz,
       'captured', 'charge')
    `);

    await reconcileWeeklyPayouts(NOW);

    const [row] = await db.select().from(payouts).where(sql`tenant_id = ${tid}::uuid`);
    expect(row?.grossPaise).toBe(0);
    expect(row?.advancesPaise).toBe(15000);
    expect(row?.advanceRecoupedPaise).toBe(0);
    expect(row?.amountPaise).toBe(15000);
  });

  it('the final tranche recoups an advance released in an earlier week', async () => {
    const { tid, bid } = await seedTenant('Advance Recoup Co');
    // Advance released BEFORE the window (already paid); settlement releases
    // in-window → this week pays settle − advance.
    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, amount_paise, settle_base_paise,
        advance_paise, advance_released_at, status, kind, settlement_released_at
      ) values
      (${bid}::uuid, ${tid}::uuid, 'stub', 51209, 50000,
       15000, '2026-05-10T10:00:00Z'::timestamptz,
       'captured', 'charge', ${RELEASED_IN_WINDOW}::timestamptz)
    `);

    await reconcileWeeklyPayouts(NOW);

    const [row] = await db.select().from(payouts).where(sql`tenant_id = ${tid}::uuid`);
    expect(row?.grossPaise).toBe(50000);
    expect(row?.advancesPaise).toBe(0);
    expect(row?.advanceRecoupedPaise).toBe(15000);
    expect(row?.amountPaise).toBe(35000);
  });

  it('same-week capture + release degenerates to plain net (advance cancels out)', async () => {
    const { tid, bid } = await seedTenant('Advance SameWeek Co');
    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, amount_paise, settle_base_paise,
        advance_paise, advance_released_at, status, kind, settlement_released_at
      ) values
      (${bid}::uuid, ${tid}::uuid, 'stub', 51209, 50000,
       15000, ${RELEASED_IN_WINDOW}::timestamptz,
       'captured', 'charge', ${RELEASED_IN_WINDOW}::timestamptz)
    `);

    await reconcileWeeklyPayouts(NOW);

    const [row] = await db.select().from(payouts).where(sql`tenant_id = ${tid}::uuid`);
    expect(row?.advancesPaise).toBe(15000);
    expect(row?.advanceRecoupedPaise).toBe(15000);
    expect(row?.amountPaise).toBe(50000);
  });

  it('an unreleased advance (never paid) is NOT recouped from the final', async () => {
    const { tid, bid } = await seedTenant('Advance Unreleased Co');
    // advance_paise set but advance_released_at NULL (e.g. captured via a path
    // that never stamped it) — the final must pay the full settle base.
    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, amount_paise, settle_base_paise,
        advance_paise, advance_released_at, status, kind, settlement_released_at
      ) values
      (${bid}::uuid, ${tid}::uuid, 'stub', 51209, 50000,
       15000, null, 'captured', 'charge', ${RELEASED_IN_WINDOW}::timestamptz)
    `);

    await reconcileWeeklyPayouts(NOW);

    const [row] = await db.select().from(payouts).where(sql`tenant_id = ${tid}::uuid`);
    expect(row?.advancesPaise).toBe(0);
    expect(row?.advanceRecoupedPaise).toBe(0);
    expect(row?.amountPaise).toBe(50000);
  });

  it('breaks a payout down by item and by customer, and reconciles', async () => {
    // Its own tenant and period: reconcile writes one row per (tenant, period),
    // so sharing a tenant with another test would make whichever ran second a
    // silent no-op.
    const [t] = await db
      .insert(tenants)
      .values({
        name: 'Payout Breakdown Co',
        slug: `payoutbd-${Date.now()}-${extraTenantIds.length}`,
        commissionBps: 0,
      })
      .returning();
    extraTenantIds.push(t!.id);

    const [v] = await db
      .insert(venues)
      .values({ tenantId: t!.id, name: 'Breakdown Arena', tzName: 'Asia/Kolkata' })
      .returning();

    const [b] = await db
      .insert(bookings)
      .values({
        tenantId: t!.id,
        venueId: v!.id,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        customerName: 'Breakdown Buyer',
        customerContact: '+91-9000000111',
        totalPaise: 50000,
        createdByUserId: userId,
      })
      .returning();

    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, amount_paise, settle_base_paise,
        status, kind, settlement_released_at, created_at
      ) values (
        ${b!.id}::uuid, ${t!.id}::uuid, 'stub', 46088, 50000,
        'captured', 'charge', ${RELEASED_IN_WINDOW}::timestamptz, ${RELEASED_IN_WINDOW}::timestamptz
      )
    `);

    await reconcileWeeklyPayouts(NOW);
    const [payout] = await db.select().from(payouts).where(sql`tenant_id = ${t!.id}::uuid`);
    expect(payout).toBeTruthy();

    const breakdown = await getPayoutBreakdown(payout!.id);
    expect(breakdown).toBeTruthy();

    // A slot booking is what the venue was paid for.
    const venueLine = breakdown!.byItem.find((l) => l.kind === 'venue');
    expect(venueLine).toBeTruthy();
    expect(venueLine!.label).toBe('Breakdown Arena');
    expect(venueLine!.grossPaise).toBe(50000);

    // And the customer behind it is nameable without an id.
    const consumerLine = breakdown!.byConsumer[0];
    expect(consumerLine).toBeTruthy();
    expect(consumerLine!.label).toBe('Breakdown Buyer');

    // The whole point: the lines must add up to what was actually paid.
    expect(breakdown!.attributedPaise + breakdown!.unattributedPaise).toBe(
      breakdown!.amountPaise,
    );
    expect(breakdown!.unattributedPaise).toBe(0);
  });

  it('returns null for a payout that does not exist', async () => {
    expect(await getPayoutBreakdown('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
