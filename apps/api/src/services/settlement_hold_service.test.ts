import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { bookings, payments, tenants, users, venues } from '../db/schema/index.js';
import { releaseDueSettlements } from './settlement_hold_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('settlement_hold_service integration', () => {
  let tenantId: string;
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
});
