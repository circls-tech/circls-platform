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
const { arenas, venues } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface TrendPoint {
  date: string;
  bookings: number;
  revenuePaise: number;
}
interface MoneyByCurrency {
  currency: string;
  amountMinor: number;
}
interface AnalyticsResponse {
  bookingsToday: number;
  revenueToday: MoneyByCurrency[];
  revenue7d: MoneyByCurrency[];
  occupancy7dPct: number;
  trend7d: { currency: string; days: TrendPoint[] }[];
}

/**
 * 10:00 IST on (today + offsetDays), as a timestamptz. Built from
 * (now() AT TIME ZONE 'Asia/Kolkata')::date inside Postgres so the IST day is
 * deterministic whatever the server's wall-clock zone.
 */
const istAt = (offsetDays: number) => sql`
  (((now() at time zone 'Asia/Kolkata')::date
    + make_interval(days => ${offsetDays}, mins => 600)) at time zone 'Asia/Kolkata')`;

interface BookingOpts {
  offsetDays: number;
  itemType?: 'slot' | 'event' | 'membership';
  paymentMethod?: 'razorpay_route' | 'external' | 'free';
  status?: 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  totalPaise?: number | null;
  currency?: string;
}

/** A booking row made on a given IST day. Returns its id. */
async function insertBooking(tenantId: string, opts: BookingOpts): Promise<string> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    insert into bookings (tenant_id, item_type, channel, payment_method, status,
                          total_paise, currency, created_at)
    values (${tenantId}, ${opts.itemType ?? 'slot'}, 'walkin',
            ${opts.paymentMethod ?? 'razorpay_route'}, ${opts.status ?? 'confirmed'},
            ${opts.totalPaise ?? null}, ${opts.currency ?? 'INR'}, ${istAt(opts.offsetDays)})
    returning id
  `);
  return (rows as unknown as Record<string, unknown>[])[0]!['id'] as string;
}

interface PaymentOpts {
  offsetDays: number;
  kind: 'charge' | 'refund';
  status: 'pending' | 'authorized' | 'captured' | 'failed' | 'refunded' | 'partially_refunded';
  /** Signed, as the ledger stores it: charges positive, refunds negative. */
  amountPaise: number;
  currency?: string;
}

/** A payment row dated on a given IST day. */
async function insertPayment(
  tenantId: string,
  bookingId: string,
  opts: PaymentOpts,
): Promise<void> {
  await db.execute(sql`
    insert into payments (booking_id, tenant_id, provider, amount_paise, currency,
                          status, kind, created_at)
    values (${bookingId}::uuid, ${tenantId}::uuid, 'stub', ${opts.amountPaise},
            ${opts.currency ?? 'INR'}, ${opts.status}, ${opts.kind}, ${istAt(opts.offsetDays)})
  `);
}

/** A booking paid online: the booking row plus its captured charge, same day. */
async function insertPaidBooking(
  tenantId: string,
  opts: BookingOpts & { chargePaise: number },
): Promise<string> {
  const id = await insertBooking(tenantId, { ...opts, totalPaise: opts.chargePaise });
  await insertPayment(tenantId, id, {
    offsetDays: opts.offsetDays,
    kind: 'charge',
    status: 'captured',
    amountPaise: opts.chargePaise,
    ...(opts.currency ? { currency: opts.currency } : {}),
  });
  return id;
}

/**
 * Insert one slot whose IST session date is `today + offsetDays` (IST) starting
 * at IST `hour:00` for `durMin` minutes. Slots feed occupancy only — money no
 * longer comes from them. Distinct hours per arena avoid the slots GIST
 * exclusion (overlapping live slots on one arena).
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
    payload: { name: `Analytics Co ${slug}`, slug, country: 'India', acceptTerms: true },
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
// Main analytics suite: a tenant selling across all three item types, paid
// both online and at the desk, with refunds and failures mixed in.
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

    // ── Today ──────────────────────────────────────────────────────────────
    // An event seat sold online: ₹500 captured.
    await insertPaidBooking(tenantId, { offsetDays: 0, itemType: 'event', chargePaise: 50000 });
    // A membership sold at the desk: no payment row, the booking carries it.
    await insertBooking(tenantId, {
      offsetDays: 0,
      itemType: 'membership',
      paymentMethod: 'external',
      totalPaise: 20000,
    });
    // A free registration: a booking, but no money.
    await insertBooking(tenantId, {
      offsetDays: 0,
      itemType: 'event',
      paymentMethod: 'free',
      totalPaise: 0,
    });
    // A checkout that failed, and one still open: neither is money, and
    // neither is a booking that stands.
    const failed = await insertBooking(tenantId, { offsetDays: 0, status: 'cancelled', totalPaise: 99900 });
    await insertPayment(tenantId, failed, {
      offsetDays: 0,
      kind: 'charge',
      status: 'failed',
      amountPaise: 99900,
    });
    const openCheckout = await insertBooking(tenantId, { offsetDays: 0, status: 'pending', totalPaise: 77700 });
    await insertPayment(tenantId, openCheckout, {
      offsetDays: 0,
      kind: 'charge',
      status: 'pending',
      amountPaise: 77700,
    });
    // A desk booking the partner cancelled: circls has no refund to record, so
    // the booking standing is the only signal, and it no longer does.
    await insertBooking(tenantId, {
      offsetDays: 0,
      paymentMethod: 'external',
      status: 'cancelled',
      totalPaise: 44400,
    });

    // ── today-2: a court sold online for ₹300 … ────────────────────────────
    const court = await insertPaidBooking(tenantId, { offsetDays: -2, chargePaise: 30000 });
    // … and refunded ₹100 of it today. The refund is dated today; today-2
    // keeps its ₹300.
    await insertPayment(tenantId, court, {
      offsetDays: 0,
      kind: 'refund',
      status: 'captured',
      amountPaise: -10000,
    });

    // ── today-6: the inclusive edge of the window ──────────────────────────
    await insertPaidBooking(tenantId, { offsetDays: -6, itemType: 'membership', chargePaise: 1000 });

    // ── today-9: outside the window entirely ───────────────────────────────
    await insertPaidBooking(tenantId, { offsetDays: -9, chargePaise: 999999 });

    // ── Slots, for occupancy only ──────────────────────────────────────────
    const slotBooking = await insertBooking(tenantId, { offsetDays: 0 });
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 6, status: 'booked', pricePaise: 10000, bookingId: slotBooking });
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 9, status: 'open', pricePaise: 9999 });
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 11, status: 'blocked', pricePaise: 9999 }); // out of the denominator
    await insertSlot(tenantId, arenaId, { offsetDays: 0, hour: 12, status: 'held', pricePaise: 9999 });
    await insertSlot(tenantId, arenaId, { offsetDays: -9, hour: 6, status: 'booked', pricePaise: 999999 }); // out of the window
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

  it('bookingsToday counts every kind of booking made today, cancelled ones aside', async () => {
    const a = await fetchAnalytics();
    // event (online) + membership (desk) + free registration + the slot
    // booking. The cancelled desk sale, the failed checkout and the open one
    // are all excluded.
    expect(a.bookingsToday).toBe(4);
  });

  it('revenueToday is money taken today, less refunds made today', async () => {
    const a = await fetchAnalytics();
    // 50000 online event + 20000 desk membership − 10000 refund = 60000.
    // The free registration, failed charge, pending charge and cancelled desk
    // sale contribute nothing.
    expect(a.revenueToday).toEqual([{ currency: 'INR', amountMinor: 60000 }]);
  });

  it('revenue7d spans the window and excludes what falls outside it', async () => {
    const a = await fetchAnalytics();
    // today 60000 + today-2 30000 + today-6 1000 = 91000 (today-9 excluded).
    expect(a.revenue7d).toEqual([{ currency: 'INR', amountMinor: 91000 }]);
  });

  it('occupancy7dPct is still slot utilisation, blocked excluded, rounded to 1dp', async () => {
    const a = await fetchAnalytics();
    // In-window bookable slots: 1 booked + 1 open + 1 held = 3; blocked is out
    // of the denominator and the today-9 slot is out of the window.
    expect(a.occupancy7dPct).toBe(33.3);
  });

  it('trend7d is one INR series with exactly 7 entries oldest→newest', async () => {
    const a = await fetchAnalytics();
    expect(a.trend7d).toHaveLength(1);
    expect(a.trend7d[0]!.currency).toBe('INR');
    expect(a.trend7d[0]!.days).toHaveLength(7);
    expect(a.trend7d[0]!.days.map((p) => p.date)).toEqual(windowDates);
  });

  it('trend7d dates money by the day it moved, and zeroes the quiet days', async () => {
    const a = await fetchAnalytics();
    const byDate = new Map(a.trend7d[0]!.days.map((p) => [p.date, p]));

    // today-6: the ₹10 membership.
    expect(byDate.get(windowDates[0]!)).toMatchObject({ bookings: 1, revenuePaise: 1000 });
    expect(byDate.get(windowDates[1]!)).toMatchObject({ bookings: 0, revenuePaise: 0 });
    expect(byDate.get(windowDates[2]!)).toMatchObject({ bookings: 0, revenuePaise: 0 });
    expect(byDate.get(windowDates[3]!)).toMatchObject({ bookings: 0, revenuePaise: 0 });
    // today-2: the court, still worth its full ₹300 despite today's refund.
    expect(byDate.get(windowDates[4]!)).toMatchObject({ bookings: 1, revenuePaise: 30000 });
    expect(byDate.get(windowDates[5]!)).toMatchObject({ bookings: 0, revenuePaise: 0 });
    // today: the refund lands here, on the day it was made.
    expect(byDate.get(windowDates[6]!)).toMatchObject({ bookings: 4, revenuePaise: 60000 });

    for (const p of a.trend7d[0]!.days) {
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
// The four ways the old slot-based measure disagreed with the Activity feed.
// Each of these was a live mismatch a partner could see on their dashboard.
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('tenant analytics vs the activity feed', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    // closeDb deferred to the final suite below.
  });

  async function analyticsFor(tenantId: string): Promise<AnalyticsResponse> {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/analytics`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as AnalyticsResponse;
  }

  it('an organiser who sells no court time still sees their revenue', async () => {
    // The Saur Grapes shape: events only, not a single slot. The old measure
    // read `slots` alone, so this dashboard was a permanent zero.
    const s = await setup(app, 'owner', `anev-${Date.now()}`);
    await insertPaidBooking(s.tenantId, { offsetDays: 0, itemType: 'event', chargePaise: 114000 });
    const a = await analyticsFor(s.tenantId);
    expect(a.revenueToday).toEqual([{ currency: 'INR', amountMinor: 114000 }]);
    expect(a.bookingsToday).toBe(1);
  });

  it('a court booked today for next month counts today, not next month', async () => {
    const s = await setup(app, 'owner', `andate-${Date.now()}`);
    const id = await insertPaidBooking(s.tenantId, { offsetDays: 0, chargePaise: 25000 });
    // The session is 30 days out; the money moved today.
    await insertSlot(s.tenantId, s.arenaId, {
      offsetDays: 30,
      hour: 6,
      status: 'booked',
      pricePaise: 25000,
      bookingId: id,
    });
    const a = await analyticsFor(s.tenantId);
    expect(a.revenueToday).toEqual([{ currency: 'INR', amountMinor: 25000 }]);
  });

  it('revenue is what was charged, not the slot price it was charged against', async () => {
    const s = await setup(app, 'owner', `ancoup-${Date.now()}`);
    // A ₹500 slot sold for ₹400 with a coupon: nothing writes the discount
    // back to the slot, so the list price was never the money taken.
    const id = await insertBooking(s.tenantId, { offsetDays: 0, totalPaise: 40000 });
    await insertPayment(s.tenantId, id, {
      offsetDays: 0,
      kind: 'charge',
      status: 'captured',
      amountPaise: 40000,
    });
    await insertSlot(s.tenantId, s.arenaId, {
      offsetDays: 0,
      hour: 6,
      status: 'booked',
      pricePaise: 50000,
      bookingId: id,
    });
    const a = await analyticsFor(s.tenantId);
    expect(a.revenueToday).toEqual([{ currency: 'INR', amountMinor: 40000 }]);
  });

  it('cancelling a paid booking today does not erase the day it was sold', async () => {
    const s = await setup(app, 'owner', `ancan-${Date.now()}`);
    const id = await insertPaidBooking(s.tenantId, { offsetDays: -3, chargePaise: 60000 });
    // Freeing the slots is what the old measure keyed on, and it wiped the
    // sale out of history retroactively.
    await insertSlot(s.tenantId, s.arenaId, {
      offsetDays: -3,
      hour: 6,
      status: 'open',
      pricePaise: 60000,
    });
    await db.execute(sql`update bookings set status = 'cancelled' where id = ${id}::uuid`);
    // Refunded in full today.
    await insertPayment(s.tenantId, id, {
      offsetDays: 0,
      kind: 'refund',
      status: 'captured',
      amountPaise: -60000,
    });

    const a = await analyticsFor(s.tenantId);
    const days = a.trend7d[0]!.days;
    // The sale still stands on its own day; today carries the refund.
    expect(days[3]!.revenuePaise).toBe(60000);
    expect(days[6]!.revenuePaise).toBe(-60000);
    // Over the window the two cancel out, which is the truth.
    expect(a.revenue7d).toEqual([]);
    expect(a.revenueToday).toEqual([{ currency: 'INR', amountMinor: -60000 }]);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation: B's money must not affect A's analytics
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('tenant analytics isolation', () => {
  let app: FastifyInstance;
  let tenantAId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const sA = await setup(app, 'owner', `aniso-a-${Date.now()}`);
    tenantAId = sA.tenantId;
    const sB = await setup(app, 'ownerB', `aniso-b-${Date.now()}`);

    // A: one online sale today worth ₹50.
    await insertPaidBooking(tenantAId, { offsetDays: 0, chargePaise: 5000 });
    await insertSlot(tenantAId, sA.arenaId, {
      offsetDays: 0,
      hour: 6,
      status: 'booked',
      pricePaise: 5000,
      bookingId: await insertBooking(tenantAId, { offsetDays: 0 }),
    });

    // B: lots of money today and a desk sale — must NOT leak into A's totals.
    await insertPaidBooking(sB.tenantId, { offsetDays: 0, chargePaise: 777000 });
    await insertBooking(sB.tenantId, {
      offsetDays: -3,
      paymentMethod: 'external',
      totalPaise: 333000,
    });
  });

  afterAll(async () => {
    await app.close();
    // closeDb deferred to the final suite below.
  });

  it("B's money does not affect A's analytics", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantAId}/analytics`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const a = res.json() as AnalyticsResponse;
    expect(a.bookingsToday).toBe(2); // the paid booking + the slot's own booking
    expect(a.revenueToday).toEqual([{ currency: 'INR', amountMinor: 5000 }]);
    expect(a.revenue7d).toEqual([{ currency: 'INR', amountMinor: 5000 }]);
    expect(a.occupancy7dPct).toBe(100); // 1 booked / 1 bookable
    expect(a.trend7d[0]!.days[6]!.revenuePaise).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Zero-state: a fresh tenant returns all zeros and an empty trend
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
    // closeDb deferred to the final suite below.
  });

  it('all zeros, occupancy 0 (divide-by-zero guarded), empty revenue/trend buckets', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/analytics`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const a = res.json() as AnalyticsResponse;
    expect(a.bookingsToday).toBe(0);
    expect(a.revenueToday).toEqual([]);
    expect(a.revenue7d).toEqual([]);
    expect(a.occupancy7dPct).toBe(0);
    expect(a.trend7d).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mixed currencies: read off the payment, never guessed from the venue's
// country — a tenant selling in both India and the USA gets separate buckets.
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('tenant analytics mixed currencies', () => {
  let app: FastifyInstance;
  let tenantId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const s = await setup(app, 'owner', `anmix-${Date.now()}`);
    tenantId = s.tenantId;

    await insertPaidBooking(tenantId, { offsetDays: 0, chargePaise: 5000 }); // ₹50.00
    await insertPaidBooking(tenantId, {
      offsetDays: 0,
      itemType: 'event',
      chargePaise: 2599, // $25.99
      currency: 'USD',
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('buckets revenue and trend per currency', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/analytics`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const a = res.json() as AnalyticsResponse;

    expect(a.bookingsToday).toBe(2);
    expect(a.revenueToday).toEqual([
      { currency: 'INR', amountMinor: 5000 },
      { currency: 'USD', amountMinor: 2599 },
    ]);
    expect(a.revenue7d).toEqual([
      { currency: 'INR', amountMinor: 5000 },
      { currency: 'USD', amountMinor: 2599 },
    ]);

    expect(a.trend7d.map((s) => s.currency).sort()).toEqual(['INR', 'USD']);
    for (const series of a.trend7d) {
      expect(series.days).toHaveLength(7);
      expect(series.days[6]!.revenuePaise).toBe(series.currency === 'USD' ? 2599 : 5000);
    }
  });
});
