import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import {
  arenas,
  auditLog,
  bookings,
  slots,
  tenants,
  users,
  venues,
} from '../db/schema/index.js';
import { sweepAbandonedCarts } from './booking_service_track_b.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('booking_service_track_b.sweepAbandonedCarts', () => {
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  let userId: string;

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `bt-fb-${Date.now()}`, email: `bt-${Date.now()}@test.x` })
      .returning();
    userId = u!.id;

    const [t] = await db
      .insert(tenants)
      .values({ name: 'Bt Co', slug: `btco-${Date.now()}` })
      .returning();
    tenantId = t!.id;

    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'V', tzName: 'Asia/Kolkata' })
      .returning();
    venueId = v!.id;

    const [a] = await db.insert(arenas).values({ venueId, name: 'A' }).returning();
    arenaId = a!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`update slots set booking_id = null where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slots where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from arenas where id = ${arenaId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${userId}`);
    await closeDb();
  });

  /**
   * Insert an old pending razorpay_route booking (created > 1 day ago) linked
   * to a fresh far-future slot. Returns the booking + slot ids so the test can
   * assert on both rows.
   */
  async function seedOldPending(dateIso: string, paymentMethod: 'razorpay_route' | 'external' = 'razorpay_route'): Promise<{ bookingId: string; slotId: string }> {
    const [slotRow] = await db.execute<{ id: string }>(sql`
      insert into slots (tenant_id, arena_id, time_range, price_paise, status)
      values (
        ${tenantId}::uuid, ${arenaId}::uuid,
        tstzrange(${dateIso}::timestamptz, (${dateIso}::timestamptz + interval '1 hour'), '[)'),
        50000, 'booked'
      )
      returning id
    `);
    const slotId = (slotRow as { id: string }).id;

    // Insert the booking with an explicitly back-dated created_at so the
    // grace window (default 15 min) is well exceeded.
    const [bookingRow] = await db.execute<{ id: string }>(sql`
      insert into bookings (
        tenant_id, venue_id, item_type, channel, payment_method, status,
        customer_name, customer_contact, total_paise, created_by_user_id,
        created_at, updated_at
      ) values (
        ${tenantId}::uuid, ${venueId}::uuid, 'slot', 'circls', ${paymentMethod}, 'pending',
        'Cart Test', '+91-9000000999', 50000, ${userId}::uuid,
        now() - interval '1 day', now()
      ) returning id
    `);
    const bookingId = (bookingRow as { id: string }).id;

    await db.execute(
      sql`update slots set booking_id = ${bookingId}::uuid where id = ${slotId}::uuid`,
    );

    return { bookingId, slotId };
  }

  it('cancels an old pending razorpay_route booking and frees its slot', async () => {
    const { bookingId, slotId } = await seedOldPending('2032-01-05T05:00:00.000Z');

    const cancelled = await sweepAbandonedCarts();
    expect(cancelled).toBeGreaterThanOrEqual(1);

    const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
    expect(book?.status).toBe('cancelled');

    const [slotAfter] = await db.select().from(slots).where(sql`id = ${slotId}`);
    expect(slotAfter?.status).toBe('open');
    expect(slotAfter?.bookingId).toBeNull();

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(sql`entity_id = ${bookingId} and action = 'booking.abandoned_cart_cancelled'`);
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });

  it('leaves recent pending bookings alone', async () => {
    // Insert a booking created right now (still inside the grace window).
    const [slotRow] = await db.execute<{ id: string }>(sql`
      insert into slots (tenant_id, arena_id, time_range, price_paise, status)
      values (
        ${tenantId}::uuid, ${arenaId}::uuid,
        tstzrange('2032-02-05T05:00:00.000Z'::timestamptz, '2032-02-05T06:00:00.000Z'::timestamptz, '[)'),
        50000, 'booked'
      )
      returning id
    `);
    const slotId = (slotRow as { id: string }).id;

    const [bookingRow] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'pending',
        customerName: 'Fresh Test',
        customerContact: '+91-9000000123',
        totalPaise: 50000,
        createdByUserId: userId,
      })
      .returning();
    await db.execute(
      sql`update slots set booking_id = ${bookingRow!.id}::uuid where id = ${slotId}::uuid`,
    );

    await sweepAbandonedCarts();

    const [book] = await db.select().from(bookings).where(sql`id = ${bookingRow!.id}`);
    expect(book?.status).toBe('pending');
  });

  it('does not touch external (walk-in) pending bookings even if old', async () => {
    const { bookingId } = await seedOldPending('2032-03-05T05:00:00.000Z', 'external');

    await sweepAbandonedCarts();

    const [book] = await db.select().from(bookings).where(sql`id = ${bookingId}`);
    expect(book?.status).toBe('pending');
  });
});
