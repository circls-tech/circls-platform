import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_actowner', email: 'actowner@x.com', email_verified: true },
      other: { uid: 'fbuid_actother', email: 'actother@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { arenas, bookings, events, memberships, userMemberships, users, venues } = await import(
  '../db/schema/index.js'
);
const { buildServer } = await import('../server.js');
const { listActivity } = await import('../services/activity_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface FeedRow {
  id: string;
  itemType: 'slot' | 'event' | 'membership';
  status: string;
  customerName: string | null;
  totalPaise: number | null;
  venueName: string | null;
  itemName: string | null;
  startAt: string | null;
  endAt: string | null;
  createdAt: string;
}
interface FeedPage {
  rows: FeedRow[];
  nextCursor: string | null;
}

/** A booked slot whose IST session date is today + offsetDays (see analytics.test.ts). */
async function insertBookedSlot(
  tenantId: string,
  arenaId: string,
  bookingId: string,
  opts: { offsetDays: number; hour: number },
): Promise<void> {
  await db.execute(sql`
    insert into slots (tenant_id, arena_id, time_range, price_paise, status, booking_id)
    values (
      ${tenantId},
      ${arenaId},
      tstzrange(
        (((now() at time zone 'Asia/Kolkata')::date
          + make_interval(days => ${opts.offsetDays}, mins => ${opts.hour * 60})) at time zone 'Asia/Kolkata'),
        (((now() at time zone 'Asia/Kolkata')::date
          + make_interval(days => ${opts.offsetDays}, mins => ${opts.hour * 60 + 60})) at time zone 'Asia/Kolkata'),
        '[)'
      ),
      10000,
      'booked',
      ${bookingId}
    )
  `);
}

/** Today's IST date as 'YYYY-MM-DD', straight from Postgres. */
async function istToday(): Promise<string> {
  const rows = await db.execute<Record<string, unknown>>(
    sql`select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as d`,
  );
  return (rows as unknown as Record<string, unknown>[])[0]!['d'] as string;
}

describe.skipIf(!runIntegration)('tenant activity', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let today: string;
  let slotBookingId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    today = await istToday();

    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Activity Co', slug: `actco-${Date.now()}` },
    });
    expect(t.statusCode).toBe(200);
    tenantId = t.json().id as string;

    const [v] = await db.insert(venues).values({ tenantId, name: 'Activity Venue' }).returning();
    venueId = v!.id;
    const [a] = await db.insert(arenas).values({ venueId, name: 'Court 1' }).returning();

    const [consumer] = await db
      .insert(users)
      .values({ firebaseUid: `fbuid_act_consumer_${Date.now()}`, displayName: 'Mia Member' })
      .returning();

    // 1) Confirmed walk-in slot booking with a slot today (IST).
    const [slotBooking] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        channel: 'walkin',
        paymentMethod: 'external',
        status: 'confirmed',
        customerName: 'Walk-in Wally',
        customerContact: '+919999999999',
        slotArenaId: a!.id,
        // bookSlots persists arena + times on the booking row itself; mirror that.
        timeRange: sql`tstzrange(
          (((now() at time zone 'Asia/Kolkata')::date + make_interval(mins => 7 * 60)) at time zone 'Asia/Kolkata'),
          (((now() at time zone 'Asia/Kolkata')::date + make_interval(mins => 8 * 60)) at time zone 'Asia/Kolkata'),
          '[)'
        )` as unknown as string,
        totalPaise: 10000,
      })
      .returning();
    slotBookingId = slotBooking!.id;
    await insertBookedSlot(tenantId, a!.id, slotBookingId, { offsetDays: 0, hour: 7 });

    // 2) Cancelled slot booking today — must NOT count on the calendar.
    const [cancelled] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        channel: 'walkin',
        paymentMethod: 'external',
        status: 'cancelled',
        customerName: 'Cancelled Carl',
        slotArenaId: a!.id,
        timeRange: sql`tstzrange(
          (((now() at time zone 'Asia/Kolkata')::date + make_interval(mins => 9 * 60)) at time zone 'Asia/Kolkata'),
          (((now() at time zone 'Asia/Kolkata')::date + make_interval(mins => 10 * 60)) at time zone 'Asia/Kolkata'),
          '[)'
        )` as unknown as string,
        totalPaise: 10000,
      })
      .returning();
    expect(cancelled).toBeDefined();

    // 3) Event registration.
    const [ev] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Sunday Smash',
        startsAt: new Date('2032-06-06T04:30:00Z'),
        endsAt: new Date('2032-06-06T07:30:00Z'),
        status: 'published',
      })
      .returning();
    await db.insert(bookings).values({
      tenantId,
      venueId,
      itemType: 'event',
      channel: 'circls',
      paymentMethod: 'razorpay_route',
      status: 'confirmed',
      customerName: 'Eva Event',
      totalPaise: 50000,
      itemData: { eventId: ev!.id },
    });

    // 4) Membership plan + a PAID purchase (bookings row, stamped) and a FREE
    //    purchase (user_memberships only — the union branch).
    const [plan] = await db
      .insert(memberships)
      .values({ tenantId, name: 'Gold Plan', durationDays: 30, status: 'active' })
      .returning();

    const [paidUm] = await db
      .insert(userMemberships)
      .values({
        userId: consumer!.id,
        membershipId: plan!.id,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 10 * 24 * 3600 * 1000), // ends in 10 days
        status: 'active',
      })
      .returning();
    await db.insert(bookings).values({
      tenantId,
      venueId: null,
      itemType: 'membership',
      channel: 'circls',
      paymentMethod: 'razorpay_route',
      status: 'confirmed',
      customerUserId: consumer!.id,
      totalPaise: 99900,
      itemData: { membershipId: plan!.id, userMembershipId: paidUm!.id },
    });

    await db.insert(userMemberships).values({
      userId: consumer!.id,
      membershipId: plan!.id,
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 60 * 24 * 3600 * 1000), // ends in 60 days — outside the 30d window
      status: 'active',
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  async function fetchFeed(query = ''): Promise<FeedPage> {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/activity${query}`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as FeedPage;
  }

  it('unifies slot, event and membership activity — including booking-less free purchases', async () => {
    const page = await fetchFeed();
    // 2 slot bookings + 1 event + 1 paid membership + 1 free membership = 5
    expect(page.rows).toHaveLength(5);

    const slot = page.rows.find((r) => r.customerName === 'Walk-in Wally');
    expect(slot).toMatchObject({ itemType: 'slot', itemName: 'Court 1', venueName: 'Activity Venue' });
    expect(slot!.startAt).toBeTruthy();

    const event = page.rows.find((r) => r.itemType === 'event');
    expect(event).toMatchObject({ itemName: 'Sunday Smash', customerName: 'Eva Event', totalPaise: 50000 });

    const mems = page.rows.filter((r) => r.itemType === 'membership');
    expect(mems).toHaveLength(2);
    for (const m of mems) {
      expect(m.itemName).toBe('Gold Plan');
      expect(m.customerName).toBe('Mia Member'); // resolved from customer_user_id / user_memberships
    }
    expect(mems.map((m) => m.totalPaise).sort()).toEqual([0, 99900]); // free + paid
  });

  it('filters by type, customer search, and venue', async () => {
    const events_ = await fetchFeed('?type=event');
    expect(events_.rows).toHaveLength(1);
    expect(events_.rows[0]!.itemType).toBe('event');

    const byName = await fetchFeed('?q=wally');
    expect(byName.rows).toHaveLength(1);
    expect(byName.rows[0]!.customerName).toBe('Walk-in Wally');

    const byVenue = await fetchFeed(`?venueId=${venueId}`);
    // memberships are org-scoped (venue_id null) → excluded by the venue filter
    expect(byVenue.rows.map((r) => r.itemType).sort()).toEqual(['event', 'slot', 'slot']);
  });

  it('sessionDate filters to sessions starting that IST day', async () => {
    const page = await fetchFeed(`?sessionDate=${today}&tz=Asia%2FKolkata`);
    // both slot bookings (confirmed + cancelled) have sessions today; event is in 2032
    expect(page.rows.map((r) => r.itemType)).toEqual(['slot', 'slot']);
  });

  it('paginates with a keyset cursor', async () => {
    const first = await fetchFeed('?limit=2');
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const rest = await fetchFeed(`?limit=10&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(rest.rows).toHaveLength(3);
    expect(rest.nextCursor).toBeNull();

    const ids = [...first.rows, ...rest.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(5); // no overlap, no loss
  });

  it('daily counts mark today with the confirmed sessions only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/activity/daily?month=${today.slice(0, 7)}&tz=Asia%2FKolkata`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const days = res.json() as { date: string; bookings: number }[];
    const todayRow = days.find((d) => d.date === today);
    // 1 confirmed slot booking; the cancelled one is excluded, the event is in 2032
    expect(todayRow).toMatchObject({ bookings: 1 });
  });

  it('membership-windows returns starting + soon-ending purchases, not far-future ends', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/activity/membership-windows?withinDays=30`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const w = res.json() as {
      starting: { membershipName: string; buyerName: string | null }[];
      ending: { membershipName: string }[];
    };
    expect(w.starting).toHaveLength(2); // both purchases started now
    expect(w.starting[0]!.buyerName).toBe('Mia Member');
    expect(w.ending).toHaveLength(1); // only the 10-day one; 60-day end is outside the window
  });

  it('service-level cursor round-trips out-of-band', async () => {
    const first = await listActivity(tenantId, { limit: 1 });
    expect(first.rows).toHaveLength(1);
    const second = await listActivity(tenantId, { limit: 10, cursor: first.nextCursor! });
    expect(second.rows.some((r) => r.id === first.rows[0]!.id)).toBe(false);
  });

  it('requires auth and tenant membership', async () => {
    const noAuth = await app.inject({ method: 'GET', url: `/v1/tenants/${tenantId}/activity` });
    expect(noAuth.statusCode).toBe(401);

    const forbidden = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/activity`,
      headers: bearer('other'),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('rejects bad month and timezone with 400', async () => {
    const badMonth = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/activity/daily?month=2026-13`,
      headers: bearer('owner'),
    });
    expect(badMonth.statusCode).toBe(400);

    const badTz = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/activity/daily?month=2026-07&tz=Not%2FAZone`,
      headers: bearer('owner'),
    });
    expect(badTz.statusCode).toBe(400);
  });
});
