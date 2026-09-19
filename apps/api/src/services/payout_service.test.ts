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

  // The Saur Grapes payout (17–24 Aug 2026), rebuilt with its real numbers.
  // The partner expected ₹10,800 and saw less; every rupee of the gap was two
  // lines the old per-customer view couldn't explain:
  //  - Yugal: a ₹600 ticket charged at ₹614.51 (grossed up for the gateway
  //    fee), refunded in full in the same week. Net −₹14.51 — the fee.
  //  - Himanshu: paid out the week before, refunded this week. Gross 0 against
  //    a ₹614.17 refund — a clawback of an earlier payout.
  it('explains each booking: what it was for, its tier, and how its refund lands', async () => {
    const stamp = `${Date.now()}-${extraTenantIds.length}`;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'Saur Grapes', slug: `saurgrapes-${stamp}`, commissionBps: 0 })
      .returning();
    const tid = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId: tid, name: 'Grape Grounds', tzName: 'Asia/Kolkata' })
      .returning();

    const PRIOR_RELEASE = '2026-05-13T10:00:00.000Z'; // week of 11–18 May
    const PRIOR_NOW = new Date('2026-05-22T09:30:00Z'); // settles 11–18 May
    const REFUND_AT = '2026-05-21T10:00:00.000Z'; // week of 18–25 May

    try {
      const [ev] = (await db.execute(sql`
        insert into events (tenant_id, venue_id, name, starts_at, ends_at, status)
        values (${tid}::uuid, ${v!.id}::uuid, 'Grape Stomp',
                '2026-05-30T10:00:00Z', '2026-05-30T13:00:00Z', 'published')
        returning id
      `)) as unknown as { id: string }[];
      const [gold] = (await db.execute(sql`
        insert into event_ticket_tiers (event_id, tenant_id, name, price_paise, sort_order)
        values (${ev!.id}::uuid, ${tid}::uuid, 'Gold', 140000, 0)
        returning id
      `)) as unknown as { id: string }[];

      const booking = async (
        name: string,
        itemType: 'event' | 'membership',
        itemData: Record<string, string>,
      ) => {
        const [b] = await db
          .insert(bookings)
          .values({
            tenantId: tid,
            venueId: v!.id,
            itemType,
            itemData,
            channel: 'circls',
            paymentMethod: 'razorpay_route',
            status: 'confirmed',
            customerName: name,
            customerContact: '+91-9000000222',
            totalPaise: 0,
            createdByUserId: userId,
          })
          .returning();
        return b!.id;
      };
      const charge = (bookingId: string, cash: number, base: number, releasedAt: string) =>
        db.execute(sql`
          insert into payments (booking_id, tenant_id, provider, amount_paise, settle_base_paise,
                                status, kind, settlement_released_at, created_at)
          values (${bookingId}::uuid, ${tid}::uuid, 'stub', ${cash}, ${base},
                  'captured', 'charge', ${releasedAt}::timestamptz, ${releasedAt}::timestamptz)
        `);
      // settle_base left null: the legacy fallback deducts the full customer
      // cash, gateway fee included — exactly the Saur Grapes rows.
      const refund = (bookingId: string, cash: number) =>
        db.execute(sql`
          insert into payments (booking_id, tenant_id, provider, amount_paise, settle_base_paise,
                                status, kind, settlement_released_at, created_at)
          values (${bookingId}::uuid, ${tid}::uuid, 'stub', ${-cash}, null,
                  'captured', 'refund', null, ${REFUND_AT}::timestamptz)
        `);

      // Himanshu's ticket was paid out the week before…
      const himanshu = await booking('Himanshu Pazare', 'event', { eventId: ev!.id });
      await charge(himanshu, 61417, 60000, PRIOR_RELEASE);
      await reconcileWeeklyPayouts(PRIOR_NOW);
      const [prior] = await db.select().from(payouts).where(sql`tenant_id = ${tid}::uuid`);
      expect(prior).toBeTruthy();

      // …and refunded this week, alongside Yugal's same-week refund.
      await refund(himanshu, 61417);
      const yugal = await booking('Yugal Shelke', 'event', { eventId: ev!.id });
      await charge(yugal, 61451, 60000, RELEASED_IN_WINDOW);
      await refund(yugal, 61451);

      // One more ordinary sale, with a tier on it.
      const sharvaree = await booking('Sharvaree Ganvir', 'event', { eventId: ev!.id });
      await db.execute(sql`
        insert into event_booking_tickets (booking_id, tier_id, quantity, unit_price_paise)
        values (${sharvaree}::uuid, ${gold!.id}::uuid, 1, 140000)
      `);
      await charge(sharvaree, 140000, 140000, RELEASED_IN_WINDOW);

      // And a membership, whose tier comes from the member row.
      const [plan] = (await db.execute(sql`
        insert into memberships (tenant_id, name, duration_days) values (${tid}::uuid, 'Vine Club', 30)
        returning id
      `)) as unknown as { id: string }[];
      const [tier] = (await db.execute(sql`
        insert into membership_tiers (membership_id, tenant_id, name, duration_days, price_paise)
        values (${plan!.id}::uuid, ${tid}::uuid, 'Monthly', 30, 50000) returning id
      `)) as unknown as { id: string }[];
      const [um] = (await db.execute(sql`
        insert into user_memberships (membership_id, membership_tier_id, external_name, starts_at, ends_at)
        values (${plan!.id}::uuid, ${tier!.id}::uuid, 'Maria George',
                '2026-05-20T00:00:00Z', '2026-06-19T00:00:00Z') returning id
      `)) as unknown as { id: string }[];
      const maria = await booking('Maria George', 'membership', {
        membershipId: plan!.id,
        userMembershipId: um!.id,
      });
      await charge(maria, 50000, 50000, RELEASED_IN_WINDOW);

      // A payment that succeeded after its booking was cancelled (a late UPI
      // success): refunded automatically, never given a settlement hold, so
      // the partner never had it.
      const lateUpi = await booking('Late UPI Payer', 'event', { eventId: ev!.id });
      await db.execute(sql`
        insert into payments (booking_id, tenant_id, provider, amount_paise, settle_base_paise,
                              status, kind, settlement_released_at, created_at)
        values (${lateUpi}::uuid, ${tid}::uuid, 'stub', 60037, 60000,
                'refunded', 'charge', null, ${REFUND_AT}::timestamptz)
      `);
      await refund(lateUpi, 60037);

      await reconcileWeeklyPayouts(NOW);
      const [current] = await db
        .select()
        .from(payouts)
        .where(sql`tenant_id = ${tid}::uuid and id <> ${prior!.id}::uuid`);
      const bd = (await getPayoutBreakdown(current!.id))!;
      const line = (name: string) => bd.byBooking.find((l) => l.customerName === name)!;

      // Yugal: paid out and refunded in the same payout; the −₹14.51 is the fee.
      expect(line('Yugal Shelke')).toMatchObject({
        grossPaise: 60000,
        refundsPaise: 61451,
        netPaise: -1451,
        refundFeePaise: 1451,
        refundTiming: 'same_payout',
        paidInPayout: null,
      });

      // Himanshu: nothing paid this week, and the line says where the money went.
      const h = line('Himanshu Pazare');
      expect(h).toMatchObject({
        grossPaise: 0,
        refundsPaise: 61417,
        refundFeePaise: 1417,
        refundTiming: 'earlier_payout',
      });
      expect(h.paidInPayout?.id).toBe(prior!.id);

      // What each booking was for, and on which tier.
      expect(line('Sharvaree Ganvir')).toMatchObject({
        itemType: 'event',
        itemName: 'Grape Stomp',
        detail: '1× Gold',
        refundTiming: 'none',
        refundFeePaise: 0,
      });
      expect(line('Maria George')).toMatchObject({
        itemType: 'membership',
        itemName: 'Vine Club',
        detail: 'Monthly',
      });

      // Named for what it is, and never treated as the partner's fee.
      expect(line('Late UPI Payer')).toMatchObject({
        grossPaise: 0,
        refundTiming: 'never_credited',
        refundFeePaise: 0,
        paidInPayout: null,
      });

      // Still reconciles to the penny, and one line per booking.
      expect(bd.unattributedPaise).toBe(0);
      expect(bd.byBooking).toHaveLength(5);
      expect(bd.byBooking.reduce((sum, l) => sum + l.netPaise, 0)).toBe(bd.amountPaise);
    } finally {
      await db.execute(sql`delete from event_booking_tickets where booking_id in
                             (select id from bookings where tenant_id = ${tid}::uuid)`);
      await db.execute(sql`delete from payouts where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from payments where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from bookings where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from user_memberships where membership_id in
                             (select id from memberships where tenant_id = ${tid}::uuid)`);
      await db.execute(sql`delete from membership_tiers where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from memberships where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from event_ticket_tiers where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from events where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from venues where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from tenants where id = ${tid}::uuid`);
    }
  });

  it('returns null for a payout that does not exist', async () => {
    expect(await getPayoutBreakdown('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
