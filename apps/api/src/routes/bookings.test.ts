import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_bowner', email: 'bowner@x.com', email_verified: true },
      other: { uid: 'fbuid_bother', email: 'bother@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const withKey = (t: string, key: string) => ({ ...bearer(t), 'idempotency-key': key });

describe.skipIf(!runIntegration)('walk-in bookings (slot-based)', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let arenaId: string;
  let slotId: string;
  let bookingId: string;

  // Pick safely-future dates at runtime so a released 10:00 slot is always still
  // 'open' whenever CI runs. (Previously these were hardcoded to 2026-07-01/-02,
  // which turned into a time bomb: once that day passed, the 10:00 slot was in
  // the past and no slot came back 'open'.) `wed` is the next Wednesday at least
  // a week out; `thu` is the day after it.
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);
  const dayAfter = (d: Date) => {
    const x = new Date(d);
    x.setUTCDate(d.getUTCDate() + 1);
    return x;
  };
  const wed = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 7); // at least a week out
    while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1); // 3 = Wednesday
    return d;
  })();
  const thu = dayAfter(wed); // 4 = Thursday

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Book Co', slug: `bco-${Date.now()}` },
    });
    tenantId = t.json().id;

    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Court Complex' },
    });
    const venueId = v.json().id;

    const a = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Court A' },
    });
    arenaId = a.json().id;

    // Release one slot on the next future Wednesday (10:00).
    await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaId}/slots/release`,
      headers: withKey('owner', `setup-${Date.now()}`),
      payload: {
        startDate: isoDay(wed),
        endDate: isoDay(wed),
        quantizationMin: 60,
        cells: [{ dayOfWeek: 3, startTimeMin: 600, durationMin: 60, price: 50000 }], // 10:00 Wed
      },
    });

    // Grab the slot id
    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=${isoDay(wed)}T00:00:00Z&to=${isoDay(dayAfter(wed))}T00:00:00Z`,
      headers: bearer('owner'),
    });
    const slots = slotsRes.json() as Array<{ id: string; status: string }>;
    slotId = slots.find((s) => s.status === 'open')!.id;
  });

  afterAll(async () => {
    await app.close();
    // Note: closeDb() is called by the multi-tier event suite's afterAll (the
    // last describe in this file) so the shared pool stays open across suites.
  });

  it('requires an Idempotency-Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: bearer('owner'),
      payload: { slotIds: [slotId], customer: { name: 'Alice', contact: '1234' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('creates a confirmed walk-in booking', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('owner', `k1-${Date.now()}`),
      payload: { slotIds: [slotId], customer: { name: 'Alice', contact: '+91-9999900000' } },
    });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    bookingId = b.id;
    expect(b.channel).toBe('walkin');
    expect(b.paymentMethod).toBe('external');
    expect(b.status).toBe('confirmed');
    expect(b.totalPaise).toBe(50000);
  });

  it('rejects a double-booking with 409 slot_taken', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('owner', `k2-${Date.now()}`),
      payload: { slotIds: [slotId], customer: { name: 'Bob', contact: '5678' } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('slot_taken');
  });

  it('is idempotent: same key returns the same booking', async () => {
    // We need a fresh open slot for this idempotency test.
    // Release an extra slot on the Thursday after `wed` (10:00).
    const relRes = await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaId}/slots/release`,
      headers: withKey('owner', `setup2-${Date.now()}`),
      payload: {
        startDate: isoDay(thu),
        endDate: isoDay(thu),
        quantizationMin: 60,
        cells: [{ dayOfWeek: 4, startTimeMin: 600, durationMin: 60, price: 20000 }], // 10:00 Thu
      },
    });
    expect(relRes.statusCode).toBe(200);

    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=${isoDay(thu)}T00:00:00Z&to=${isoDay(dayAfter(thu))}T00:00:00Z`,
      headers: bearer('owner'),
    });
    const slots2 = slotsRes.json() as Array<{ id: string; status: string }>;
    const slot2Id = slots2.find((s) => s.status === 'open')!.id;

    const key = `kdup-${Date.now()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('owner', key),
      payload: { slotIds: [slot2Id], customer: { name: 'Carol', contact: '0000' } },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('owner', key),
      payload: { slotIds: [slot2Id], customer: { name: 'Carol', contact: '0000' } },
    });
    expect(first.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
  });

  it('blocks a non-member', async () => {
    // slotId is already booked; non-member should get 403 before reaching the slot lookup
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('other', `k3-${Date.now()}`),
      payload: { slotIds: [slotId], customer: { name: 'Eve', contact: '000' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('cancelling frees the slot for re-booking', async () => {
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/cancel`,
      headers: bearer('owner'),
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe('cancelled');

    const rebook = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('owner', `k4-${Date.now()}`),
      payload: { slotIds: [slotId], customer: { name: 'Alice Again', contact: '9999' } },
    });
    expect(rebook.statusCode).toBe(201);
  });
});

describe.skipIf(!runIntegration)('event bookings (multi-tier)', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let eventId: string;
  let generalTierId: string;
  let vipTierId: string;
  const SUFFIX = Date.now();

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Tier Co', slug: `tierco-${SUFFIX}` },
    });
    tenantId = t.json().id;

    // Standalone (venue-less) event so booking only gates on the active tenant.
    // Two tiers: General (uncapped) + VIP (capacity 1, so we can oversell it).
    const ev = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: { line1: '1 Test St', city: 'Mumbai' },
        tzName: 'Asia/Kolkata',
        name: 'Tiered Test Event',
        startsAt: '2030-09-01T10:00:00.000Z',
        endsAt: '2030-09-01T12:00:00.000Z',
        tiers: [
          { name: 'General', pricePaise: 50000 },
          { name: 'VIP', pricePaise: 150000, capacity: 1 },
        ],
      },
    });
    expect(ev.statusCode).toBe(200);
    eventId = (ev.json() as { id: string }).id;

    // createEvent returns only the Event row; read the tier ids back by name.
    const tierRows = (await db.execute(sql`
      select id, name from event_ticket_tiers where event_id = ${eventId} and deleted_at is null
    `)) as unknown as Array<{ id: string; name: string }>;
    generalTierId = tierRows.find((x) => x.name === 'General')!.id;
    vipTierId = tierRows.find((x) => x.name === 'VIP')!.id;

    await db.execute(sql`update events set status='published' where id = ${eventId}`);
  });

  afterAll(async () => {
    await db.execute(sql`delete from event_booking_tickets where tier_id in (${generalTierId}, ${vipTierId})`);
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from event_ticket_tiers where event_id = ${eventId}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await app.close();
    await closeDb();
  });

  it('books two tier lines and writes one ticket row per line', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${eventId}/book`,
      headers: bearer('other'),
      payload: {
        lines: [
          { tierId: generalTierId, quantity: 2 },
          { tierId: vipTierId, quantity: 1 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { booking: { id: string } };
    const bookingId = body.booking.id;

    const rows = (await db.execute(sql`
      select tier_id, quantity from event_booking_tickets
      where booking_id = ${bookingId}
      order by quantity
    `)) as unknown as Array<{ tier_id: string; quantity: number }>;
    expect(rows).toHaveLength(2);
    const byTier = new Map(rows.map((r) => [r.tier_id, Number(r.quantity)]));
    expect(byTier.get(generalTierId)).toBe(2);
    expect(byTier.get(vipTierId)).toBe(1);
  });

  it('rejects buying beyond a capped tier with 409 tier_sold_out', async () => {
    // The VIP tier (capacity 1) is now sold out from the previous test.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${eventId}/book`,
      headers: bearer('other'),
      payload: { lines: [{ tierId: vipTierId, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('tier_sold_out');
  });
});
