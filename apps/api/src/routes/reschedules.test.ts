import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_rsowner', email: 'rsowner@x.com', email_verified: true },
      customer: { uid: 'fbuid_rscustomer', email: 'rscustomer@x.com', email_verified: true },
      staff: { uid: 'fbuid_rsstaff', email: 'rsstaff@x.com', email_verified: true },
      readonly: { uid: 'fbuid_rsreadonly', email: 'rsreadonly@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { bookings, payments, slots, tenantMembers } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface RescheduleResult {
  bookingId: string;
  status: string;
  arenaId: string;
  fromSlotIds: string[];
  toSlotIds: string[];
  startAt: string;
  endAt: string;
  paidPaise: number;
  newTotalPaise: number;
  priceDeltaPaise: number;
  settledAt: string | null;
}

describe.skipIf(!runIntegration)('POST /v1/bookings/:id/reschedule', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let arenaAId: string;
  let arenaBId: string;
  let otherVenueArenaId: string;
  let customerUserId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Resched Co', slug: `rsco-${Date.now()}`, country: 'India', acceptTerms: true },
    });
    expect(t.statusCode).toBe(200);
    tenantId = t.json().id;

    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Resched Venue' },
    });
    expect(v.statusCode).toBe(200);
    venueId = v.json().id;
    const v2 = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Other Venue' },
    });
    expect(v2.statusCode).toBe(200);

    async function mkArena(vid: string, name: string): Promise<string> {
      const a = await app.inject({
        method: 'POST',
        url: `/v1/venues/${vid}/arenas`,
        headers: bearer('owner'),
        payload: { name },
      });
      expect(a.statusCode).toBe(200);
      return (a.json() as { id: string }).id;
    }
    arenaAId = await mkArena(venueId, 'Court A');
    arenaBId = await mkArena(venueId, 'Court B');
    otherVenueArenaId = await mkArena(v2.json().id as string, 'Elsewhere');

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('customer') });
    expect(me.statusCode).toBe(200);
    customerUserId = (me.json() as { id: string }).id;

    for (const role of ['staff', 'readonly'] as const) {
      const member = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(role) });
      expect(member.statusCode).toBe(200);
      await db.insert(tenantMembers).values({ userId: (member.json() as { id: string }).id, tenantId, role });
    }
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  /** An open slot on `arenaId` starting `hoursAhead` from now, one hour long. */
  async function seedSlot(arenaId: string, hoursAhead: number, pricePaise = 50000): Promise<string> {
    const start = new Date(Date.now() + hoursAhead * 3_600_000);
    const end = new Date(start.getTime() + 3_600_000);
    const [s] = await db
      .insert(slots)
      .values({
        tenantId,
        arenaId,
        timeRange: `[${start.toISOString()},${end.toISOString()})`,
        pricePaise,
        status: 'open',
      })
      .returning();
    return s!.id;
  }

  /** A confirmed, paid online booking holding `slotIds` (all on one arena). */
  async function seedBooking(slotIds: string[], arenaId: string): Promise<string> {
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        slotArenaId: arenaId,
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        customerName: 'Resched Test',
        customerContact: '+91-9000000789',
        customerUserId,
        totalPaise: 50000 * slotIds.length,
        timeRange: sql`(select tstzrange(min(lower(time_range)), max(upper(time_range)), '[)') from slots where id = any(${sql.raw(`array['${slotIds.join("','")}']::uuid[]`)}))`,
      })
      .returning();
    await db
      .update(slots)
      .set({ status: 'booked', bookingId: b!.id })
      .where(sql`${slots.id} = any(${sql.raw(`array['${slotIds.join("','")}']::uuid[]`)})`);
    await db.insert(payments).values({
      bookingId: b!.id,
      tenantId,
      provider: 'stub',
      amountPaise: 50000 * slotIds.length,
      status: 'captured',
      kind: 'charge',
      settlementHoldUntil: new Date(Date.now() + 3_600_000),
    });
    return b!.id;
  }

  async function slotState(id: string) {
    const [s] = await db.select({ status: slots.status, bookingId: slots.bookingId }).from(slots).where(eq(slots.id, id));
    return s!;
  }

  it('moves a confirmed booking to open slots on another court, keeping its id and payment', async () => {
    const oldSlot = await seedSlot(arenaAId, 30);
    const bookingId = await seedBooking([oldSlot], arenaAId);
    const newSlot1 = await seedSlot(arenaBId, 50, 60000);
    const newSlot2 = await seedSlot(arenaBId, 51, 60000);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/reschedule`,
      headers: bearer('staff'),
      payload: { slotIds: [newSlot1, newSlot2], reason: 'Customer asked for Saturday' },
    });
    expect(res.statusCode).toBe(200);
    const r = res.json() as RescheduleResult;
    expect(r.bookingId).toBe(bookingId);
    expect(r.status).toBe('confirmed');
    expect(r.arenaId).toBe(arenaBId);
    expect(r.fromSlotIds).toEqual([oldSlot]);
    expect(r.toSlotIds.sort()).toEqual([newSlot1, newSlot2].sort());
    expect(r.paidPaise).toBe(50000);
    expect(r.newTotalPaise).toBe(120000);
    expect(r.priceDeltaPaise).toBe(70000);
    // Two one-hour slots seeded a few ms apart: a two-hour span, give or take.
    const span = new Date(r.endAt).getTime() - new Date(r.startAt).getTime();
    expect(span).toBeGreaterThanOrEqual(2 * 3_600_000);
    expect(span).toBeLessThan(2 * 3_600_000 + 1000);

    expect(await slotState(oldSlot)).toEqual({ status: 'open', bookingId: null });
    expect(await slotState(newSlot1)).toEqual({ status: 'booked', bookingId });
    expect(await slotState(newSlot2)).toEqual({ status: 'booked', bookingId });

    const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(b!.slotArenaId).toBe(arenaBId);
    expect(b!.totalPaise).toBe(50000);
    expect((b!.itemData as { lastReschedule: { priceDeltaPaise: number } }).lastReschedule.priceDeltaPaise).toBe(70000);

    // The hold moved to after the new end.
    const [p] = await db.select({ hold: payments.settlementHoldUntil }).from(payments).where(eq(payments.bookingId, bookingId));
    expect(p!.hold!.getTime()).toBeGreaterThan(new Date(r.endAt).getTime());

    // The detail read follows the slots.
    const detail = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}`, headers: bearer('owner') });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { slots: unknown[]; arenaName: string }).slots).toHaveLength(2);
    expect((detail.json() as { arenaName: string }).arenaName).toBe('Court B');
  });

  it('records the difference as an external adjustment, at move time or later', async () => {
    // Later: the move leaves it outstanding, the settle call records it.
    const oldSlot = await seedSlot(arenaAId, 40);
    const bookingId = await seedBooking([oldSlot], arenaAId);
    const dearer = await seedSlot(arenaBId, 41, 80000);
    const moved = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/reschedule`,
      headers: bearer('owner'),
      payload: { slotIds: [dearer] },
    });
    expect(moved.statusCode).toBe(200);
    expect((moved.json() as RescheduleResult).settledAt).toBeNull();
    const detailBefore = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}`, headers: bearer('owner') });
    expect((detailBefore.json() as { lastReschedule: { priceDeltaPaise: number; settledAt: string | null } }).lastReschedule).toMatchObject({ priceDeltaPaise: 30000, settledAt: null });

    const settled = await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/reschedule/settle`, headers: bearer('staff') });
    expect(settled.statusCode).toBe(200);
    expect((settled.json() as { amountPaise: number }).amountPaise).toBe(30000);
    const [adj] = await db.select().from(payments).where(sql`${payments.bookingId} = ${bookingId} and ${payments.kind} = 'adjustment'`);
    expect(adj).toMatchObject({ provider: 'external', status: 'captured', amountPaise: 30000 });
    const detailAfter = await app.inject({ method: 'GET', url: `/v1/bookings/${bookingId}`, headers: bearer('owner') });
    expect((detailAfter.json() as { lastReschedule: { settledAt: string | null } }).lastReschedule.settledAt).not.toBeNull();
    // Once only.
    const again = await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/reschedule/settle`, headers: bearer('owner') });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe('already_settled');

    // At move time: settleNow writes the row inside the move.
    const old2 = await seedSlot(arenaAId, 45);
    const booking2 = await seedBooking([old2], arenaAId);
    const cheaper = await seedSlot(arenaBId, 46, 20000);
    const movedNow = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${booking2}/reschedule`,
      headers: bearer('owner'),
      payload: { slotIds: [cheaper], settleNow: true },
    });
    expect(movedNow.statusCode).toBe(200);
    expect((movedNow.json() as RescheduleResult).settledAt).not.toBeNull();
    const [adj2] = await db.select().from(payments).where(sql`${payments.bookingId} = ${booking2} and ${payments.kind} = 'adjustment'`);
    expect(adj2).toMatchObject({ provider: 'external', amountPaise: -30000 });

    // Nothing to settle when the price did not change.
    const old3 = await seedSlot(arenaAId, 47);
    const booking3 = await seedBooking([old3], arenaAId);
    const same = await seedSlot(arenaBId, 48, 50000);
    await app.inject({ method: 'POST', url: `/v1/bookings/${booking3}/reschedule`, headers: bearer('owner'), payload: { slotIds: [same], settleNow: true } });
    const none = await app.inject({ method: 'POST', url: `/v1/bookings/${booking3}/reschedule/settle`, headers: bearer('owner') });
    expect(none.statusCode).toBe(409);
    expect((none.json() as { error: { code: string } }).error.code).toBe('no_difference');
  });

  it('can shift along the same court, re-taking a slot it just gave up', async () => {
    const s1 = await seedSlot(arenaAId, 60);
    const s2 = await seedSlot(arenaAId, 61);
    const s3 = await seedSlot(arenaAId, 62);
    const bookingId = await seedBooking([s1, s2], arenaAId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/reschedule`,
      headers: bearer('owner'),
      payload: { slotIds: [s2, s3] },
    });
    expect(res.statusCode).toBe(200);
    expect(await slotState(s1)).toEqual({ status: 'open', bookingId: null });
    expect(await slotState(s2)).toEqual({ status: 'booked', bookingId });
    expect(await slotState(s3)).toEqual({ status: 'booked', bookingId });
  });

  it('leaves everything as it was when a target slot is taken', async () => {
    const oldSlot = await seedSlot(arenaAId, 70);
    const bookingId = await seedBooking([oldSlot], arenaAId);
    const taken = await seedSlot(arenaBId, 71);
    const otherBooking = await seedBooking([taken], arenaBId);
    const free = await seedSlot(arenaBId, 72);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/reschedule`,
      headers: bearer('owner'),
      payload: { slotIds: [taken, free] },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('slot_taken');
    expect(await slotState(oldSlot)).toEqual({ status: 'booked', bookingId });
    expect(await slotState(taken)).toEqual({ status: 'booked', bookingId: otherBooking });
    expect(await slotState(free)).toEqual({ status: 'open', bookingId: null });
  });

  it('refuses slots at another venue, the same slots, a cancelled booking, and a Read-only member', async () => {
    const oldSlot = await seedSlot(arenaAId, 80);
    const bookingId = await seedBooking([oldSlot], arenaAId);
    const elsewhere = await seedSlot(otherVenueArenaId, 81);

    const mixed = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/reschedule`,
      headers: bearer('owner'),
      payload: { slotIds: [elsewhere] },
    });
    expect(mixed.statusCode).toBe(409);
    expect((mixed.json() as { error: { code: string } }).error.code).toBe('mixed_venue_slots');

    const same = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/reschedule`,
      headers: bearer('owner'),
      payload: { slotIds: [oldSlot] },
    });
    expect(same.statusCode).toBe(409);
    expect((same.json() as { error: { code: string } }).error.code).toBe('same_slots');

    const fresh = await seedSlot(arenaAId, 82);
    const readonly = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/reschedule`,
      headers: bearer('readonly'),
      payload: { slotIds: [fresh] },
    });
    expect(readonly.statusCode).toBe(403);

    // The customer may ask, not move it themselves.
    const customer = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/reschedule`,
      headers: bearer('customer'),
      payload: { slotIds: [fresh] },
    });
    expect(customer.statusCode).toBe(403);

    await db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, bookingId));
    const cancelled = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/reschedule`,
      headers: bearer('owner'),
      payload: { slotIds: [fresh] },
    });
    expect(cancelled.statusCode).toBe(409);
    expect((cancelled.json() as { error: { code: string } }).error.code).toBe('booking_not_confirmed');
  });
});
