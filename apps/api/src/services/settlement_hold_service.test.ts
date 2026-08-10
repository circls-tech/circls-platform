import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { bookings, events, payments, tenants, users, venues } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { holdForBooking, releaseDueSettlements } from './settlement_hold_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('settlement_hold_service integration', () => {
  let tenantId: string;
  let venueId: string;
  let bookingId: string;
  let userId: string;

  beforeAll(async () => {
    await pingDb();

    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `set-fb-${Date.now()}`, email: `set-${Date.now()}@test.x` })
      .returning();
    userId = u!.id;

    const [t] = await db
      .insert(tenants)
      .values({ name: 'Set Co', slug: `setco-${Date.now()}` })
      .returning();
    tenantId = t!.id;

    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'V', tzName: 'Asia/Kolkata' })
      .returning();
    venueId = v!.id;

    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId: v!.id,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        customerName: 'Set Test',
        customerContact: '+91-9000000888',
        totalPaise: 50000,
        createdByUserId: userId,
      })
      .returning();
    bookingId = b!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(
      sql`delete from venues where tenant_id = ${tenantId}`,
    );
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${userId}`);
    await closeDb();
  });

  /** Helper: drop and re-seed two payments — one due, one not. Returns ids. */
  async function seedTwoCaptured(): Promise<{ dueId: string; futureId: string }> {
    // Wipe any prior payments for this booking to keep counts clean.
    await db.execute(sql`delete from payments where booking_id = ${bookingId}`);

    const [dueRow] = await db.execute<{ id: string }>(sql`
      insert into payments (
        booking_id, tenant_id, provider, provider_payment_id, amount_paise,
        status, kind, settlement_hold_until
      ) values (
        ${bookingId}::uuid, ${tenantId}::uuid, 'stub', 'pay_due_1', 50000,
        'captured', 'charge', now() - interval '5 minutes'
      ) returning id
    `);

    const [futureRow] = await db.execute<{ id: string }>(sql`
      insert into payments (
        booking_id, tenant_id, provider, provider_payment_id, amount_paise,
        status, kind, settlement_hold_until
      ) values (
        ${bookingId}::uuid, ${tenantId}::uuid, 'stub', 'pay_future_1', 50000,
        'captured', 'charge', now() + interval '1 hour'
      ) returning id
    `);

    return {
      dueId: (dueRow as { id: string }).id,
      futureId: (futureRow as { id: string }).id,
    };
  }

  it('releases only payments whose settlement_hold_until is in the past', async () => {
    const { dueId, futureId } = await seedTwoCaptured();

    const releasedCount = await releaseDueSettlements();
    expect(releasedCount).toBeGreaterThanOrEqual(1);

    const [due] = await db.select().from(payments).where(sql`id = ${dueId}`);
    expect(due?.settlementReleasedAt).not.toBeNull();

    const [future] = await db.select().from(payments).where(sql`id = ${futureId}`);
    expect(future?.settlementReleasedAt).toBeNull();
  });

  it('does not re-release rows already marked released', async () => {
    // Sleep + re-run: second pass should not pick the previously-released row.
    const before = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingId} and settlement_released_at is not null`);
    const beforeCount = before.length;

    const releasedAgain = await releaseDueSettlements();
    // No new dues were inserted, so the count should be zero.
    expect(releasedAgain).toBe(0);

    const after = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingId} and settlement_released_at is not null`);
    expect(after.length).toBe(beforeCount);
  });

  it('ignores payments that are pending/failed even if hold is past', async () => {
    await db.execute(sql`delete from payments where booking_id = ${bookingId}`);
    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, provider_payment_id, amount_paise,
        status, kind, settlement_hold_until
      ) values
        (${bookingId}::uuid, ${tenantId}::uuid, 'stub', 'pay_pending_1', 50000,
         'pending', 'charge', now() - interval '5 minutes'),
        (${bookingId}::uuid, ${tenantId}::uuid, 'stub', 'pay_failed_1', 50000,
         'failed', 'charge', now() - interval '5 minutes')
    `);

    const released = await releaseDueSettlements();
    expect(released).toBe(0);
  });

  it('releases charges that were refunded before their hold elapsed', async () => {
    await db.execute(sql`delete from payments where booking_id = ${bookingId}`);
    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, provider_payment_id, amount_paise,
        status, kind, settlement_hold_until
      ) values
        (${bookingId}::uuid, ${tenantId}::uuid, 'stub', 'pay_refunded_1', 50000,
         'refunded', 'charge', now() - interval '5 minutes'),
        (${bookingId}::uuid, ${tenantId}::uuid, 'stub', 'pay_partial_1', 50000,
         'partially_refunded', 'charge', now() - interval '5 minutes')
    `);

    const released = await releaseDueSettlements();
    expect(released).toBe(2);
  });

  it('holdForBooking anchors event bookings on the event ends_at', async () => {
    const endsAt = new Date(Date.now() + 3 * 86_400_000); // 3 days out
    const [ev] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Hold Test Event',
        startsAt: new Date(endsAt.getTime() - 3600_000),
        endsAt,
        status: 'published',
      })
      .returning();

    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'event',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        totalPaise: 30000,
        itemData: { eventId: ev!.id, eventName: ev!.name },
        createdByUserId: userId,
      })
      .returning();

    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, provider_payment_id, amount_paise, status, kind
      ) values (
        ${b!.id}::uuid, ${tenantId}::uuid, 'stub', 'pay_event_1', 30000, 'captured', 'charge'
      )
    `);

    await holdForBooking(b!.id);

    const [pay] = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${b!.id}`);
    const expected = endsAt.getTime() + env.SETTLEMENT_HOLD_BUFFER_MIN * 60_000;
    expect(pay?.settlementHoldUntil?.getTime()).toBe(expected);
  });

  it('holdForBooking falls back to now() + buffer when the booking has no end anchor', async () => {
    // Memberships' synthetic bookings: no time_range, no eventId in item_data.
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'membership',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        totalPaise: 100000,
        itemData: { membershipId: '00000000-0000-0000-0000-000000000000' },
        createdByUserId: userId,
      })
      .returning();

    await db.execute(sql`
      insert into payments (
        booking_id, tenant_id, provider, provider_payment_id, amount_paise, status, kind
      ) values (
        ${b!.id}::uuid, ${tenantId}::uuid, 'stub', 'pay_membership_1', 100000, 'captured', 'charge'
      )
    `);

    const before = Date.now();
    await holdForBooking(b!.id);
    const after = Date.now();

    const [pay] = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${b!.id}`);
    const hold = pay?.settlementHoldUntil?.getTime();
    const bufferMs = env.SETTLEMENT_HOLD_BUFFER_MIN * 60_000;
    // now() is the DB clock; allow a generous skew window around the JS clock.
    expect(hold).toBeGreaterThanOrEqual(before + bufferMs - 60_000);
    expect(hold).toBeLessThanOrEqual(after + bufferMs + 60_000);
  });
});
