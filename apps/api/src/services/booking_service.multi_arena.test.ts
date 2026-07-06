import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { arenas, bookings, slots, tenants, users, venues } from '../db/schema/index.js';
import { prepareOnlineBookingWithPayment } from './booking_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

/**
 * A consumer cart can hold slots from several courts of one venue. We book that
 * as a SINGLE multi-arena booking: one booking row, one payment. This guards the
 * relaxed single-arena assertion — the booking row's slot_arena_id is left NULL
 * (the per-slot claim is the real double-booking guard), while both slots are
 * still claimed atomically across their two arenas.
 */
describe.skipIf(!runIntegration)('prepareOnlineBookingWithPayment (multi-arena)', () => {
  let tenantId: string;
  let venueId: string;
  let arenaAId: string;
  let arenaBId: string;
  let slotAId: string;
  let slotBId: string;
  let userId: string;

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `ma-fb-${Date.now()}`, email: `ma-${Date.now()}@test.x` })
      .returning();
    userId = u!.id;

    const [t] = await db
      .insert(tenants)
      .values({ name: 'Ma Co', slug: `maco-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;

    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'MaV', tzName: 'Asia/Kolkata', status: 'active' })
      .returning();
    venueId = v!.id;

    const [a1] = await db.insert(arenas).values({ venueId, name: 'Court A' }).returning();
    const [a2] = await db.insert(arenas).values({ venueId, name: 'Court B' }).returning();
    arenaAId = a1!.id;
    arenaBId = a2!.id;

    // One far-future open slot per court so the booking is bookable.
    const [s1] = await db.execute<{ id: string }>(sql`
      insert into slots (tenant_id, arena_id, time_range, price_paise, status)
      values (${tenantId}::uuid, ${arenaAId}::uuid,
        tstzrange('2032-05-01T05:00:00.000Z'::timestamptz, '2032-05-01T05:30:00.000Z'::timestamptz, '[)'),
        50000, 'open')
      returning id`);
    const [s2] = await db.execute<{ id: string }>(sql`
      insert into slots (tenant_id, arena_id, time_range, price_paise, status)
      values (${tenantId}::uuid, ${arenaBId}::uuid,
        tstzrange('2032-05-01T05:00:00.000Z'::timestamptz, '2032-05-01T05:30:00.000Z'::timestamptz, '[)'),
        50000, 'open')
      returning id`);
    slotAId = (s1 as { id: string }).id;
    slotBId = (s2 as { id: string }).id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`update slots set booking_id = null where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slots where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from arenas where venue_id = ${venueId}`);
    await db.execute(sql`delete from venues where id = ${venueId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${userId}`);
    await closeDb();
  });

  it('books slots from two courts as one booking with a null slot_arena_id', async () => {
    const result = await prepareOnlineBookingWithPayment(
      { tenantId, actorUserId: userId },
      venueId,
      { slotIds: [slotAId, slotBId], customerName: 'Cart Buyer', customerContact: '+15555550102' },
    );

    expect(result.bookingId).toBeTruthy();

    // One booking, spanning courts → no single arena recorded.
    const [book] = await db.select().from(bookings).where(sql`id = ${result.bookingId}`);
    expect(book?.itemType).toBe('slot');
    expect(book?.slotArenaId).toBeNull();
    expect(Number(book?.basePaise)).toBe(100000);

    // Both slots claimed by that booking, across the two distinct arenas.
    const claimed = await db
      .select({ id: slots.id, arenaId: slots.arenaId, status: slots.status, bookingId: slots.bookingId })
      .from(slots)
      .where(sql`booking_id = ${result.bookingId}`);
    expect(claimed).toHaveLength(2);
    expect(claimed.every((c) => c.status === 'booked')).toBe(true);
    expect(new Set(claimed.map((c) => c.arenaId))).toEqual(new Set([arenaAId, arenaBId]));
  });
});
