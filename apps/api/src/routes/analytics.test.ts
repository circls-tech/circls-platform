import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_anowner', email: 'anowner@x.com', email_verified: true },
      ownerB: { uid: 'fbuid_anownerb', email: 'anownerb@x.com', email_verified: true },
      other: { uid: 'fbuid_another', email: 'another@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { arenas, bookings, venues } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface TrendPoint {
  date: string;
  bookings: number;
  revenuePaise: number;
}
interface AnalyticsResponse {
  bookingsToday: number;
  revenueTodayPaise: number;
  revenue7dPaise: number;
  occupancy7dPct: number;
  trend7d: TrendPoint[];
}

/**
 * Insert one slot whose IST session date is `today + offsetDays` (IST) starting
 * at IST `hour:00` for `durMin` minutes. Building the tstzrange from
 * (now() AT TIME ZONE 'Asia/Kolkata')::date inside Postgres makes the IST date
 * deterministic regardless of the server wall-clock. Distinct hours per arena
 * avoid the slots GIST exclusion (overlapping live slots on one arena).
 */
async function insertSlot(
  tenantId: string,
  arenaId: string,
  opts: {
    offsetDays: number;
    hour: number;
    durMin?: number;
    status: 'open' | 'held' | 'blocked' | 'booked';
    pricePaise: number;
    bookingId?: string | null;
    deleted?: boolean;
  },
): Promise<void> {
  const durMin = opts.durMin ?? 60;
  await db.execute(sql`
    insert into slots (tenant_id, arena_id, time_range, price_paise, status, booking_id, deleted_at)
    values (
      ${tenantId},
      ${arenaId},
      tstzrange(
        (((now() at time zone 'Asia/Kolkata')::date
          + make_interval(days => ${opts.offsetDays}, mins => ${opts.hour * 60})) at time zone 'Asia/Kolkata'),
        (((now() at time zone 'Asia/Kolkata')::date
          + make_interval(days => ${opts.offsetDays}, mins => ${opts.hour * 60 + durMin})) at time zone 'Asia/Kolkata'),
        '[)'
      ),
      ${opts.pricePaise},
      ${opts.status},
      ${opts.bookingId ?? null},
      ${opts.deleted ? sql`now()` : null}
    )
  `);
}

/**
 * Insert a minimal walk-in booking row and return its generated id. The slots
 * carry the arena + times (bookings.time_range / slot_arena_id stay null), so
 * the bookings GIST exclusion never applies; this just satisfies the
 * slots.booking_id → bookings.id FK.
 */
async function createBooking(tenantId: string): Promise<string> {
  const [b] = await db
    .insert(bookings)
    .values({ tenantId, itemType: 'slot', channel: 'walkin', paymentMethod: 'external', status: 'confirmed' })
    .returning({ id: bookings.id });
  return b!.id;
}

/** Create a tenant via the route (owner becomes a member) + a venue + arena directly. */
async function setup(
  app: FastifyInstance,
  token: string,
  slug: string,
): Promise<{ tenantId: string; arenaId: string }> {
  const t = await app.inject({
    method: 'POST',
    url: '/v1/tenants',
    headers: bearer(token),
    payload: { name: `Analytics Co ${slug}`, slug },
  });
  expect(t.statusCode).toBe(200);
  const tenantId = t.json().id as string;

  const [v] = await db.insert(venues).values({ tenantId, name: 'Analytics Venue' }).returning();
  const [a] = await db.insert(arenas).values({ venueId: v!.id, name: 'Analytics Arena' }).returning();
  return { tenantId, arenaId: a!.id };
}

/** The 7 IST date strings (today-6 … today), straight from Postgres. */
async function istWindowDates(): Promise<string[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select to_char(d, 'YYYY-MM-DD') as date
    from generate_series(
      (now() at time zone 'Asia/Kolkata')::date - 6,
      (now() at time zone 'Asia/Kolkata')::date,
      interval '1 day'
    ) as d
    order by d
  `);
  return (rows as unknown as Record<string, unknown>[]).map((r) => r['date'] as string);
}

// ---------------------------------------------------------------------------
// Main analytics suite: a fully-seeded tenant with the expected aggregates
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('tenant analytics', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let arenaId: string;
  let windowDates: string[];

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const s = await setup(app, 'owner', `anco-${Date.now()}`);
    tenantId = s.tenantId;
    arenaId = s.arenaId;
    windowDates = await istWindowDates();

    const B1 = await createBooking(tenantId);
    const B2 = await createBooking(tenantId);
    const B3 = await createBooking(tenantId);
    const B4 = await createBooking(tenantId);
    const B5 = await createBooking(tenantId);
    const B6 = await createBooking(tenantId);

    // --- Today (offset 0)
    // Two booked slots share booking B1 → distinct bookings counts them once.
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 6, status: 'booked', pricePaise: 10000, bookingId: B1 });
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 7, status: 'booked', pricePaise: 12000, bookingId: B1 });
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 8, status: 'booked', pricePaise: 5000, bookingId: B2 });
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 9, status: 'open', pricePaise: 9999 });
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 10, status: 'open', pricePaise: 9999 });
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 11, status: 'blocked', pricePaise: 9999 }); // excluded from occupancy denom
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 12, status: 'held', pricePaise: 9999 }); // counts in occupancy denom

    // --- today-2
    await insertSlot(tenantId, arenaId, { offsetDays: -2, hour: 6, status: 'booked', pricePaise: 30000, bookingId: B3 });
    await insertSlot(tenantId, arenaId, { offsetDays: -2, hour: 7, status: 'open', pricePaise: 1 });

    // --- today-5
    await insertSlot(tenantId, arenaId, { offsetDays: -5, hour: 6, status: 'booked', pricePaise: 7000, bookingId: B4 });

    // --- today-6 (inclusive edge of the 7-day window)
    await insertSlot(tenantId, arenaId, { offsetDays: -6, hour: 6, status: 'booked', pricePaise: 1000, bookingId: B5 });

    // --- today-9 (OUTSIDE window): must not affect revenue7d / occupancy / trend
    await insertSlot(tenantId, arenaId, { offsetDays: -9, hour: 6, status: 'booked', pricePaise: 999999, bookingId: B6 });

    // --- soft-deleted booked slot today: must be ignored everywhere
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 14, status: 'booked', pricePaise: 88888, bookingId: B6, deleted: true });
  });

  afterAll(async () => {
    await app.close();
    // closeDb deferred to the final suite below.
  });

  async function fetchAnalytics(token = 'owner'): Promise<AnalyticsResponse> {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/analytics`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as AnalyticsResponse;
  }

  it('bookingsToday counts distinct booked booking_id with IST date = today', async () => {
    const a = await fetchAnalytics();
    expect(a.bookingsToday).toBe(2); // {B1 (x2 slots), B2}
    expect(typeof a.bookingsToday).toBe('number');
  });

  it('revenueTodayPaise sums booked price for today only', async () => {
    const a = await fetchAnalytics();
    expect(a.revenueTodayPaise).toBe(27000); // 10000 + 12000 + 5000
    expect(typeof a.revenueTodayPaise).toBe('number');
  });

  it('revenue7dPaise includes older booked slots within the window, excludes the out-of-window one', async () => {
    const a = await fetchAnalytics();
    // today 27000 + today-2 30000 + today-5 7000 + today-6 1000 = 65000 (today-9 excluded)
    expect(a.revenue7dPaise).toBe(65000);
    expect(typeof a.revenue7dPaise).toBe('number');
  });

  it('occupancy7dPct = booked / (open+held+booked) over the window, blocked excluded, rounded to 1dp', async () => {
    const a = await fetchAnalytics();
    // booked rows in window = 3(today)+1+1+1 = 6
    // denominator (open|held|booked) = today 6 (3 booked+2 open+1 held; blocked excluded)
    //   + today-2 2 + today-5 1 + today-6 1 = 10
    // 100 * 6 / 10 = 60.0
    expect(a.occupancy7dPct).toBe(60);
  });

  it('trend7d has exactly 7 entries oldest→newest with the right IST dates', async () => {
    const a = await fetchAnalytics();
    expect(a.trend7d).toHaveLength(7);
    expect(a.trend7d.map((p) => p.date)).toEqual(windowDates);
    // last entry is today (IST)
    expect(a.trend7d[6]!.date).toBe(windowDates[6]);
  });

  it('trend7d carries the right per-day bookings/revenue and zeros on empty days', async () => {
    const a = await fetchAnalytics();
    const byDate = new Map(a.trend7d.map((p) => [p.date, p]));

    // today-6
    expect(byDate.get(windowDates[0]!)).toMatchObject({ bookings: 1, revenuePaise: 1000 });
    // today-5
    expect(byDate.get(windowDates[1]!)).toMatchObject({ bookings: 1, revenuePaise: 7000 });
    // today-4 (empty)
    expect(byDate.get(windowDates[2]!)).toMatchObject({ bookings: 0, revenuePaise: 0 });
    // today-3 (empty)
    expect(byDate.get(windowDates[3]!)).toMatchObject({ bookings: 0, revenuePaise: 0 });
    // today-2
    expect(byDate.get(windowDates[4]!)).toMatchObject({ bookings: 1, revenuePaise: 30000 });
    // today-1 (empty)
    expect(byDate.get(windowDates[5]!)).toMatchObject({ bookings: 0, revenuePaise: 0 });
    // today
    expect(byDate.get(windowDates[6]!)).toMatchObject({ bookings: 2, revenuePaise: 27000 });

    // every entry's counts are plain numbers
    for (const p of a.trend7d) {
      expect(typeof p.bookings).toBe('number');
      expect(typeof p.revenuePaise).toBe('number');
    }
  });

  it('requires auth (401 without a bearer token)', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/tenants/${tenantId}/analytics` });
    expect(res.statusCode).toBe(401);
  });

  it('non-member is forbidden (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/analytics`,
      headers: bearer('other'),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation: B's booked slots must not affect A's analytics
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('tenant analytics isolation', () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let arenaAId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const sA = await setup(app, 'owner', `aniso-a-${Date.now()}`);
    tenantAId = sA.tenantId;
    arenaAId = sA.arenaId;

    const sB = await setup(app, 'ownerB', `aniso-b-${Date.now()}`);

    // A: a single booked slot today worth 5000.
    await insertSlot(tenantAId, arenaAId, {
      offsetDays: 0,
      hour: 6,
      status: 'booked',
      pricePaise: 5000,
      bookingId: await createBooking(tenantAId),
    });

    // B: lots of booked revenue today — must NOT leak into A's totals.
    await insertSlot(sB.tenantId, sB.arenaId, {
      offsetDays: 0,
      hour: 6,
      status: 'booked',
      pricePaise: 777000,
      bookingId: await createBooking(sB.tenantId),
    });
    await insertSlot(sB.tenantId, sB.arenaId, {
      offsetDays: -3,
      hour: 6,
      status: 'booked',
      pricePaise: 333000,
      bookingId: await createBooking(sB.tenantId),
    });
  });

  afterAll(async () => {
    await app.close();
    // closeDb deferred to the final suite below.
  });

  it("B's booked slots do not affect A's analytics", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantAId}/analytics`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const a = res.json() as AnalyticsResponse;
    expect(a.bookingsToday).toBe(1);
    expect(a.revenueTodayPaise).toBe(5000);
    expect(a.revenue7dPaise).toBe(5000); // only A's today slot
    expect(a.occupancy7dPct).toBe(100); // 1 booked / 1 bookable
    expect(a.trend7d[6]!.revenuePaise).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Zero-state: a fresh tenant returns all zeros and a 7-zero trend
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('tenant analytics zero-state', () => {
  let app: FastifyInstance;
  let tenantId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const s = await setup(app, 'owner', `anzero-${Date.now()}`);
    tenantId = s.tenantId;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('all zeros, occupancy 0 (divide-by-zero guarded), trend7d of 7 zero entries', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/analytics`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const a = res.json() as AnalyticsResponse;
    expect(a.bookingsToday).toBe(0);
    expect(a.revenueTodayPaise).toBe(0);
    expect(a.revenue7dPaise).toBe(0);
    expect(a.occupancy7dPct).toBe(0);
    expect(a.trend7d).toHaveLength(7);
    for (const p of a.trend7d) {
      expect(p.bookings).toBe(0);
      expect(p.revenuePaise).toBe(0);
      expect(typeof p.date).toBe('string');
      // date is a valid YYYY-MM-DD
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
