import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_brdowner', email: 'brdowner@x.com', email_verified: true },
      ownerB: { uid: 'fbuid_brdownerb', email: 'brdownerb@x.com', email_verified: true },
      other: { uid: 'fbuid_brdother', email: 'brdother@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb } = await import('../db/client.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const withKey = (t: string, key: string) => ({ ...bearer(t), 'idempotency-key': key });

interface ListItem {
  id: string;
  customerName: string;
  customerContact: string;
  note: string | null;
  status: string;
  channel: string;
  totalPaise: number;
  createdAt: string;
  arenaId: string;
  arenaName: string;
  firstStartAt: string;
  lastEndAt: string;
  slotCount: number;
}

/**
 * Helper: stand up a tenant→venue→arena, release `cells` on `date`, and return
 * the resulting open slot ids (sorted by start) plus the key ids.
 */
async function setupArena(
  app: FastifyInstance,
  token: string,
  opts: { slug: string; date: string; cells: Array<Record<string, unknown>> },
): Promise<{ tenantId: string; venueId: string; arenaId: string; openSlotIds: string[] }> {
  const t = await app.inject({
    method: 'POST',
    url: '/v1/tenants',
    headers: bearer(token),
    payload: { name: `Read Co ${opts.slug}`, slug: opts.slug },
  });
  const tenantId = t.json().id as string;

  const v = await app.inject({
    method: 'POST',
    url: `/v1/tenants/${tenantId}/venues`,
    headers: bearer(token),
    payload: { name: 'Read Venue' },
  });
  const venueId = v.json().id as string;

  const a = await app.inject({
    method: 'POST',
    url: `/v1/venues/${venueId}/arenas`,
    headers: bearer(token),
    payload: { name: 'Read Arena', slotDurationMin: 60 },
  });
  const arenaId = a.json().id as string;

  const rel = await app.inject({
    method: 'POST',
    url: `/v1/arenas/${arenaId}/slots/release`,
    headers: withKey(token, `rd-rel-${opts.slug}-${Date.now()}`),
    payload: {
      startDate: opts.date,
      endDate: opts.date,
      quantizationMin: 60,
      cells: opts.cells,
    },
  });
  expect(rel.statusCode).toBe(200);

  const slotsRes = await app.inject({
    method: 'GET',
    url: `/v1/arenas/${arenaId}/slots?from=${opts.date}T00:00:00Z&to=${opts.date}T23:59:59Z`,
    headers: bearer(token),
  });
  const allSlots = slotsRes.json() as Array<{ id: string; status: string; startAt: string }>;
  const openSlotIds = allSlots
    .filter((s) => s.status === 'open')
    .sort((x, y) => x.startAt.localeCompare(y.startAt))
    .map((s) => s.id);

  return { tenantId, venueId, arenaId, openSlotIds };
}

async function book(
  app: FastifyInstance,
  token: string,
  slotIds: string[],
  customer: { name: string; contact: string; note?: string },
): Promise<{ id: string; totalPaise: number }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/bookings',
    headers: withKey(token, `rd-bk-${Date.now()}-${Math.random()}`),
    payload: { slotIds, customer },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

// ---------------------------------------------------------------------------
// Main read suite: a single tenant with a multi-slot booking + filters
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('bookings read endpoints', () => {
  let app: FastifyInstance;
  let venueId: string;
  let arenaId: string;
  let arenaName: string;
  let bookingId: string;
  // The multi-slot booking spans 2 of the 3 released slots (06:00 + 07:00 IST).
  const date = '2031-06-03'; // a Tuesday (dayOfWeek 2) in IST

  // The released window: 06:00, 07:00, 08:00 IST = 00:30, 01:30, 02:30 UTC.
  const windowFrom = `${date}T00:00:00Z`;
  const windowTo = `${date}T23:59:59Z`;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const s = await setupArena(app, 'owner', {
      slug: `rdco-${Date.now()}`,
      date,
      cells: [
        { dayOfWeek: 2, startTimeMin: 360, durationMin: 60, price: 10000 }, // 06:00 IST
        { dayOfWeek: 2, startTimeMin: 420, durationMin: 60, price: 12000 }, // 07:00 IST
        { dayOfWeek: 2, startTimeMin: 480, durationMin: 60, price: 15000 }, // 08:00 IST
      ],
    });
    venueId = s.venueId;
    arenaId = s.arenaId;
    expect(s.openSlotIds.length).toBeGreaterThanOrEqual(3);

    // Read back the arena name for assertion.
    const arenasRes = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
    });
    arenaName = (arenasRes.json() as Array<{ id: string; name: string }>).find(
      (ar) => ar.id === arenaId,
    )!.name;

    // Book the first 2 slots (06:00 + 07:00) under "Alice / +91-9999900000".
    const b = await book(app, 'owner', s.openSlotIds.slice(0, 2), {
      name: 'Alice',
      contact: '+91-9999900000',
      note: 'birthday',
    });
    bookingId = b.id;
  });

  afterAll(async () => {
    await app.close();
    // closeDb deferred to the tenant-isolation suite below.
  });

  it('lists the booking within a window that overlaps its slots', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=${windowFrom}&to=${windowTo}`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as ListItem[];
    const item = list.find((b) => b.id === bookingId);
    expect(item).toBeDefined();
    expect(item!.customerName).toBe('Alice');
    expect(item!.customerContact).toBe('+91-9999900000');
    expect(item!.note).toBe('birthday');
    expect(item!.status).toBe('confirmed');
    expect(item!.channel).toBe('walkin');
    expect(item!.totalPaise).toBe(22000);
    expect(typeof item!.totalPaise).toBe('number');
    expect(item!.arenaId).toBe(arenaId);
    expect(item!.arenaName).toBe(arenaName);
    expect(typeof item!.createdAt).toBe('string');
    // createdAt is a valid ISO string.
    expect(new Date(item!.createdAt).toISOString()).toBe(item!.createdAt);
  });

  it('aggregates slotCount / firstStartAt / lastEndAt for a multi-slot booking', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=${windowFrom}&to=${windowTo}`,
      headers: bearer('owner'),
    });
    const item = (res.json() as ListItem[]).find((b) => b.id === bookingId)!;
    expect(item.slotCount).toBe(2);
    expect(typeof item.slotCount).toBe('number');
    // 06:00 IST == 00:30 UTC start; 07:00 IST slot ends 08:00 IST == 02:30 UTC.
    expect(item.firstStartAt).toBe('2031-06-03T00:30:00.000Z');
    expect(item.lastEndAt).toBe('2031-06-03T02:30:00.000Z');
  });

  it('excludes the booking from a non-overlapping window', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=2031-06-10T00:00:00Z&to=2031-06-11T00:00:00Z`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as ListItem[];
    expect(list.find((b) => b.id === bookingId)).toBeUndefined();
  });

  it('arenaId filter includes the matching arena and excludes others', async () => {
    const match = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=${windowFrom}&to=${windowTo}&arenaId=${arenaId}`,
      headers: bearer('owner'),
    });
    expect(match.statusCode).toBe(200);
    expect((match.json() as ListItem[]).find((b) => b.id === bookingId)).toBeDefined();

    // A random (valid-uuid) arena that isn't ours excludes the booking.
    const otherArena = '00000000-0000-0000-0000-0000000000aa';
    const miss = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=${windowFrom}&to=${windowTo}&arenaId=${otherArena}`,
      headers: bearer('owner'),
    });
    expect(miss.statusCode).toBe(200);
    expect((miss.json() as ListItem[]).find((b) => b.id === bookingId)).toBeUndefined();
  });

  it('status filter includes confirmed and excludes a non-matching status', async () => {
    const confirmed = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=${windowFrom}&to=${windowTo}&status=confirmed`,
      headers: bearer('owner'),
    });
    expect(confirmed.statusCode).toBe(200);
    expect((confirmed.json() as ListItem[]).find((b) => b.id === bookingId)).toBeDefined();

    const cancelled = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=${windowFrom}&to=${windowTo}&status=cancelled`,
      headers: bearer('owner'),
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as ListItem[]).find((b) => b.id === bookingId)).toBeUndefined();
  });

  it('q ILIKE matches on customer name', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=${windowFrom}&to=${windowTo}&q=ali`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ListItem[]).find((b) => b.id === bookingId)).toBeDefined();
  });

  it('q ILIKE matches on customer contact', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=${windowFrom}&to=${windowTo}&q=99999`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ListItem[]).find((b) => b.id === bookingId)).toBeDefined();
  });

  it('q ILIKE misses a non-matching needle', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=${windowFrom}&to=${windowTo}&q=zzznotpresent`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ListItem[]).find((b) => b.id === bookingId)).toBeUndefined();
  });

  it('requires from and to query params (400 on missing)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /v1/bookings/:id returns the booking detail with ordered slots', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/bookings/${bookingId}`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const d = res.json() as {
      id: string;
      customerName: string;
      customerContact: string;
      note: string | null;
      status: string;
      channel: string;
      paymentMethod: string;
      totalPaise: number;
      createdAt: string;
      venueId: string;
      arenaId: string;
      arenaName: string;
      slots: Array<{ id: string; startAt: string; endAt: string; pricePaise: number; status: string }>;
    };
    expect(d.id).toBe(bookingId);
    expect(d.customerName).toBe('Alice');
    expect(d.customerContact).toBe('+91-9999900000');
    expect(d.note).toBe('birthday');
    expect(d.status).toBe('confirmed');
    expect(d.channel).toBe('walkin');
    expect(d.paymentMethod).toBe('external');
    expect(d.totalPaise).toBe(22000);
    expect(typeof d.totalPaise).toBe('number');
    expect(d.venueId).toBe(venueId);
    expect(d.arenaId).toBe(arenaId);
    expect(d.arenaName).toBe(arenaName);
    expect(d.slots).toHaveLength(2);
    // Ordered by start.
    expect(d.slots[0]!.startAt).toBe('2031-06-03T00:30:00.000Z');
    expect(d.slots[0]!.endAt).toBe('2031-06-03T01:30:00.000Z');
    expect(d.slots[0]!.pricePaise).toBe(10000);
    expect(typeof d.slots[0]!.pricePaise).toBe('number');
    expect(d.slots[0]!.status).toBe('booked');
    expect(d.slots[1]!.startAt).toBe('2031-06-03T01:30:00.000Z');
    expect(d.slots[1]!.endAt).toBe('2031-06-03T02:30:00.000Z');
    expect(d.slots[1]!.pricePaise).toBe(12000);
  });

  it('GET /v1/bookings/:id → 404 for an unknown booking', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/bookings/00000000-0000-0000-0000-0000000000ff`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('booking_not_found');
  });
});

// ---------------------------------------------------------------------------
// Cancelled bookings remain visible: the read paths fall back to bookings.slot_arena_id
// / bookings.time_range when no slots are linked (cancelBooking nulls slots.booking_id).
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('cancelled bookings remain visible', () => {
  let app: FastifyInstance;
  let venueId: string;
  let arenaId: string;
  let arenaName: string;
  let activeBookingId: string;
  let cancelledBookingId: string;
  // Legacy walk-in: cancelled BEFORE the fix, so its slot_arena_id / time_range
  // were never persisted. We simulate this by NULLing both columns directly.
  let legacyCancelledBookingId: string;

  // Tuesday 2032-06-01 in IST. Released window: 06/07/08 IST = 00:30/01:30/02:30 UTC.
  const date = '2032-06-01';
  const windowFrom = `${date}T00:00:00Z`;
  const windowTo = `${date}T23:59:59Z`;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const s = await setupArena(app, 'owner', {
      slug: `rdcanc-${Date.now()}`,
      date,
      cells: [
        { dayOfWeek: 2, startTimeMin: 360, durationMin: 60, price: 10000 }, // 06:00 IST
        { dayOfWeek: 2, startTimeMin: 420, durationMin: 60, price: 12000 }, // 07:00 IST
        { dayOfWeek: 2, startTimeMin: 480, durationMin: 60, price: 15000 }, // 08:00 IST
      ],
    });
    venueId = s.venueId;
    arenaId = s.arenaId;
    expect(s.openSlotIds.length).toBeGreaterThanOrEqual(3);

    const arenasRes = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
    });
    arenaName = (arenasRes.json() as Array<{ id: string; name: string }>).find(
      (ar) => ar.id === arenaId,
    )!.name;

    // (1) An active multi-slot booking that should still appear in the list.
    const active = await book(app, 'owner', s.openSlotIds.slice(0, 2), {
      name: 'Active Alice',
      contact: '+91-9999911111',
    });
    activeBookingId = active.id;

    // (2) A booking that we will cancel — it must remain visible.
    const cancelled = await book(app, 'owner', [s.openSlotIds[2]!], {
      name: 'Cancelled Carol',
      contact: '+91-9999922222',
      note: 'change of plans',
    });
    cancelledBookingId = cancelled.id;

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${cancelledBookingId}/cancel`,
      headers: bearer('owner'),
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.json().status).toBe('cancelled');

    // (3) Legacy walk-in: book + cancel, then NULL out the persisted fallback
    // columns to simulate a booking created BEFORE this fix shipped.
    // Use 08:30 IST = 03:00 UTC — released as an extra slot to avoid GIST overlap
    // with the previously cancelled booking's 08:00–09:00 IST window.
    const extraRel = await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaId}/slots/release`,
      headers: withKey('owner', `rd-relx-${Date.now()}`),
      payload: {
        startDate: '2032-06-08',
        endDate: '2032-06-08',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 2, startTimeMin: 540, durationMin: 60, price: 9000 }],
      },
    });
    expect(extraRel.statusCode).toBe(200);

    const xSlotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=2032-06-08T00:00:00Z&to=2032-06-09T00:00:00Z`,
      headers: bearer('owner'),
    });
    const xOpen = (xSlotsRes.json() as Array<{ id: string; status: string }>)
      .find((sl) => sl.status === 'open')!.id;

    const legacy = await book(app, 'owner', [xOpen], {
      name: 'Legacy Larry',
      contact: '+91-9999933333',
    });
    legacyCancelledBookingId = legacy.id;

    const legacyCancelRes = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${legacyCancelledBookingId}/cancel`,
      headers: bearer('owner'),
    });
    expect(legacyCancelRes.statusCode).toBe(200);

    // Simulate pre-fix state: scrub slot_arena_id + time_range from the legacy row.
    const { db } = await import('../db/client.js');
    const { sql } = await import('drizzle-orm');
    await db.execute(sql`
      update bookings
         set slot_arena_id = null, time_range = null
       where id = ${legacyCancelledBookingId}
    `);
  });

  afterAll(async () => {
    await app.close();
  });

  it('list with status=cancelled returns the cancelled booking with fallback arena + window from the booking row', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=${windowFrom}&to=${windowTo}&status=cancelled`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as ListItem[];
    const item = list.find((b) => b.id === cancelledBookingId);
    expect(item).toBeDefined();
    expect(item!.status).toBe('cancelled');
    // Arena info falls back to bookings.slot_arena_id / arenas.name via the booking-side join.
    expect(item!.arenaId).toBe(arenaId);
    expect(item!.arenaName).toBe(arenaName);
    // 08:00 IST = 02:30 UTC; ends 09:00 IST = 03:30 UTC. Persisted on the booking row.
    expect(item!.firstStartAt).toBe('2032-06-01T02:30:00.000Z');
    expect(item!.lastEndAt).toBe('2032-06-01T03:30:00.000Z');
    // No slots point at the booking anymore.
    expect(item!.slotCount).toBe(0);
  });

  it('list without status filter surfaces both the active and cancelled bookings in the window', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=${windowFrom}&to=${windowTo}`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as ListItem[];
    const active = list.find((b) => b.id === activeBookingId);
    const cancelled = list.find((b) => b.id === cancelledBookingId);
    expect(active).toBeDefined();
    expect(active!.status).toBe('confirmed');
    // The active 06:00-08:00 IST window stays correct.
    expect(active!.slotCount).toBe(2);
    expect(active!.arenaId).toBe(arenaId);
    expect(active!.arenaName).toBe(arenaName);
    expect(cancelled).toBeDefined();
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.slotCount).toBe(0);
  });

  it('GET /v1/bookings/:id for a cancelled booking returns it with slots=[] but arenaId/arenaName populated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/bookings/${cancelledBookingId}`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const d = res.json() as {
      id: string;
      status: string;
      arenaId: string | null;
      arenaName: string | null;
      slots: Array<unknown>;
    };
    expect(d.id).toBe(cancelledBookingId);
    expect(d.status).toBe('cancelled');
    expect(d.arenaId).toBe(arenaId);
    expect(d.arenaName).toBe(arenaName);
    expect(d.slots).toEqual([]);
  });

  it('cancelled booking outside the requested window does not surface', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=2032-07-10T00:00:00Z&to=2032-07-11T00:00:00Z&status=cancelled`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as ListItem[];
    expect(list.find((b) => b.id === cancelledBookingId)).toBeUndefined();
  });

  it('legacy cancelled walk-in (slot_arena_id=NULL, time_range=NULL) does NOT appear in the list (acceptable fallback gap)', async () => {
    // Pre-fix bookings never persisted the fallback columns; once cancelled, the
    // window filter has nothing to match against and they stay hidden. This is
    // documented behavior — future fix would be a one-time backfill if needed.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueId}/bookings?from=2032-06-08T00:00:00Z&to=2032-06-09T00:00:00Z&status=cancelled`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as ListItem[];
    expect(list.find((b) => b.id === legacyCancelledBookingId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation: B's booking must never surface to A
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('bookings read tenant isolation', () => {
  let app: FastifyInstance;
  let venueAId: string;
  let venueBId: string;
  let bookingBId: string;
  const date = '2031-06-10'; // a Tuesday in IST

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // Tenant A (owner) with its own booking.
    const sA = await setupArena(app, 'owner', {
      slug: `rdiso-a-${Date.now()}`,
      date,
      cells: [{ dayOfWeek: 2, startTimeMin: 360, durationMin: 60, price: 10000 }],
    });
    venueAId = sA.venueId;
    await book(app, 'owner', [sA.openSlotIds[0]!], { name: 'A Customer', contact: '111' });

    // Tenant B (ownerB) with its own booking.
    const sB = await setupArena(app, 'ownerB', {
      slug: `rdiso-b-${Date.now()}`,
      date,
      cells: [{ dayOfWeek: 2, startTimeMin: 420, durationMin: 60, price: 20000 }],
    });
    venueBId = sB.venueId;
    const bB = await book(app, 'ownerB', [sB.openSlotIds[0]!], {
      name: 'B Customer',
      contact: '222',
    });
    bookingBId = bB.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it("A's list does not include B's booking", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueAId}/bookings?from=${date}T00:00:00Z&to=${date}T23:59:59Z`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json() as ListItem[];
    expect(list.find((b) => b.id === bookingBId)).toBeUndefined();
    expect(list.every((b) => b.customerName !== 'B Customer')).toBe(true);
  });

  it("A cannot list B's venue bookings (403)", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/venues/${venueBId}/bookings?from=${date}T00:00:00Z&to=${date}T23:59:59Z`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /v1/bookings/:id for B's booking is not accessible to A (403)", async () => {
    // Per the route contract the handler runs requireTenantMembership on the
    // booking's tenant before reading detail, so a non-member of tenant B is
    // denied with 403 — B's booking never surfaces to A. (The getBookingDetail
    // service additionally throws booking_not_found on a tenant mismatch as
    // defense-in-depth; that path is covered by the service-level guard below.)
    const res = await app.inject({
      method: 'GET',
      url: `/v1/bookings/${bookingBId}`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('getBookingDetail throws booking_not_found on a tenant mismatch', async () => {
    // Defense-in-depth guard inside the service: even if a caller reaches it with
    // a tenantId that does not own the booking, it must look like a 404.
    const { getBookingDetail } = await import('../services/bookings_read_service.js');
    await expect(
      getBookingDetail('00000000-0000-0000-0000-0000000000ee', bookingBId),
    ).rejects.toMatchObject({ code: 'booking_not_found', httpStatus: 404 });
  });

  it("GET /v1/bookings/:id for B's booking → 200 for B", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/bookings/${bookingBId}`,
      headers: bearer('ownerB'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(bookingBId);
  });
});
