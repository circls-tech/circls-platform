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

/** YYYY-MM-DD string, `minDaysOut` days from now (UTC), advanced to the next
 *  occurrence of `targetDow` (0=Sun..6=Sat) — slot release refuses to create
 *  slots that start in the past, so tests can't hardcode a fixed calendar date. */
function futureWeekday(minDaysOut: number, targetDow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + minDaysOut);
  while (d.getUTCDay() !== targetDow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Advance a YYYY-MM-DD date string by `days` calendar days. */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!runIntegration)('walk-in bookings (slot-based)', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let arenaId: string;
  let slotId: string;
  let bookingId: string;
  // Wednesday + the following Thursday, at least two weeks out.
  const wedDate = futureWeekday(14, 3);
  const thuDate = addDays(wedDate, 1);

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Book Co', slug: `bco-${Date.now()}`, country: 'India', acceptTerms: true },
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

    // Release one slot on wedDate (a Wednesday)
    await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaId}/slots/release`,
      headers: withKey('owner', `setup-${Date.now()}`),
      payload: {
        startDate: wedDate,
        endDate: wedDate,
        quantizationMin: 60,
        cells: [{ dayOfWeek: 3, startTimeMin: 600, durationMin: 60, price: 50000 }], // 10:00 Wed
      },
    });

    // Grab the slot id
    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=${wedDate}T00:00:00Z&to=${thuDate}T00:00:00Z`,
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
    // We need a fresh open slot for this idempotency test
    // Release an extra slot on thuDate (the following Thursday)
    const relRes = await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaId}/slots/release`,
      headers: withKey('owner', `setup2-${Date.now()}`),
      payload: {
        startDate: thuDate,
        endDate: thuDate,
        quantizationMin: 60,
        cells: [{ dayOfWeek: 4, startTimeMin: 600, durationMin: 60, price: 20000 }], // 10:00 Thu
      },
    });
    expect(relRes.statusCode).toBe(200);

    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=${thuDate}T00:00:00Z&to=${addDays(thuDate, 1)}T00:00:00Z`,
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
  let limitedEventId: string;
  let slotATierId: string;
  let slotBTierId: string;
  let limitedBookingId: string;
  let eventBookingId: string;
  const SUFFIX = Date.now();

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Tier Co', slug: `tierco-${SUFFIX}`, country: 'India', acceptTerms: true },
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

    // Second event: free multi-slot RSVP capped at 2 tickets per customer
    // ACROSS both tiers (the per-user-limit tests). Free keeps bookings
    // auto-confirmed, no payment leg.
    const limEv = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: { line1: '1 Test St', city: 'Mumbai' },
        tzName: 'Asia/Kolkata',
        name: 'Limited Test Event',
        startsAt: '2030-09-02T10:00:00.000Z',
        endsAt: '2030-09-02T12:00:00.000Z',
        maxPerUser: 2,
        tiers: [
          { name: 'Slot A', pricePaise: 0 },
          { name: 'Slot B', pricePaise: 0 },
        ],
      },
    });
    expect(limEv.statusCode).toBe(200);
    limitedEventId = (limEv.json() as { id: string }).id;
    const limTierRows = (await db.execute(sql`
      select id, name from event_ticket_tiers where event_id = ${limitedEventId} and deleted_at is null
    `)) as unknown as Array<{ id: string; name: string }>;
    slotATierId = limTierRows.find((x) => x.name === 'Slot A')!.id;
    slotBTierId = limTierRows.find((x) => x.name === 'Slot B')!.id;

    await db.execute(sql`update events set status='published' where tenant_id = ${tenantId}`);
  });

  afterAll(async () => {
    await db.execute(sql`delete from event_booking_tickets where booking_id in (select id from bookings where tenant_id = ${tenantId})`);
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from event_ticket_tiers where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    // Confirmed (free) bookings fire notifications that reference the tenant.
    await db.execute(sql`delete from notifications where tenant_id = ${tenantId}`);
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
    eventBookingId = bookingId;

    const rows = (await db.execute(sql`
      select tier_id, quantity from event_booking_tickets
      where booking_id = ${bookingId}
      order by quantity
    `)) as unknown as Array<{ tier_id: string; quantity: number }>;
    expect(rows).toHaveLength(2);
    const byTier = new Map(rows.map((r) => [r.tier_id, Number(r.quantity)]));
    expect(byTier.get(generalTierId)).toBe(2);
    expect(byTier.get(vipTierId)).toBe(1);

    // The partner registrations list surfaces those tier lines.
    const list = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/events/${eventId}/bookings`,
      headers: bearer('owner'),
    });
    expect(list.statusCode).toBe(200);
    const listRows = (list.json() as {
      rows: Array<{ id: string; tickets: Array<{ tierName: string; quantity: number }> }>;
    }).rows;
    expect(listRows.find((x) => x.id === bookingId)?.tickets).toEqual([
      { tierName: 'General', quantity: 2 },
      { tierName: 'VIP', quantity: 1 },
    ]);
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

  it('lets tenant staff cancel an event booking, freeing tier capacity', async () => {
    // Event bookings have no slots/time_range — the cancellation engine must
    // fall back to the event's starts_at instead of failing no_slot_start.
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${eventBookingId}/cancel`,
      headers: bearer('owner'),
      payload: { reason: 'Cancelled by venue' },
    });
    expect(cancel.statusCode).toBe(200);
    const body = cancel.json() as { status: string; refundPaise: number };
    expect(body.status).toBe('cancelled');
    // The charge was never captured (payment form never completed), so the
    // cancel fails the charge instead of refunding.
    expect(body.refundPaise).toBe(0);

    // VIP (capacity 1) was sold out by that booking; the seat is free again.
    const rebook = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${eventId}/book`,
      headers: bearer('other'),
      payload: { lines: [{ tierId: vipTierId, quantity: 1 }] },
    });
    expect(rebook.statusCode).toBe(200);
  });

  it('exposes maxPerUser on the consumer event detail', async () => {
    const limited = await app.inject({ method: 'GET', url: `/v1/consumer/events/${limitedEventId}` });
    expect(limited.statusCode).toBe(200);
    expect((limited.json() as { maxPerUser: number | null }).maxPerUser).toBe(2);

    const uncapped = await app.inject({ method: 'GET', url: `/v1/consumer/events/${eventId}` });
    expect(uncapped.statusCode).toBe(200);
    expect((uncapped.json() as { maxPerUser: number | null }).maxPerUser).toBeNull();
  });

  it('rejects a single checkout above the per-user limit, summed across tiers', async () => {
    // 1 + 2 across two tiers = 3 > the event's cap of 2.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${limitedEventId}/book`,
      headers: bearer('other'),
      payload: {
        lines: [
          { tierId: slotATierId, quantity: 1 },
          { tierId: slotBTierId, quantity: 2 },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('event_user_limit');
  });

  it('enforces the limit across separate bookings by the same user', async () => {
    // One ticket in each slot = exactly the cap of 2.
    const first = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${limitedEventId}/book`,
      headers: bearer('other'),
      payload: {
        lines: [
          { tierId: slotATierId, quantity: 1 },
          { tierId: slotBTierId, quantity: 1 },
        ],
      },
    });
    expect(first.statusCode).toBe(200);
    limitedBookingId = (first.json() as { booking: { id: string } }).booking.id;

    // Any further ticket — in either slot — is over the event cap.
    const second = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${limitedEventId}/book`,
      headers: bearer('other'),
      payload: { lines: [{ tierId: slotATierId, quantity: 1 }] },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('event_user_limit');
  });

  it('does not count one user\'s tickets against another', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${limitedEventId}/book`,
      headers: bearer('owner'),
      payload: { lines: [{ tierId: slotATierId, quantity: 2 }] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('lets tenant staff cancel an event booking, freeing the per-user cap', async () => {
    // Event bookings have no slots/time_range — the cancellation engine must
    // fall back to the event's starts_at instead of failing no_slot_start.
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${limitedBookingId}/cancel`,
      headers: bearer('owner'),
      payload: { reason: 'Cancelled by venue' },
    });
    expect(cancel.statusCode).toBe(200);
    const body = cancel.json() as { status: string; refundPaise: number };
    expect(body.status).toBe('cancelled');
    expect(body.refundPaise).toBe(0); // free tiers — nothing to refund

    // 'other' was at the 2-per-event cap; the cancelled booking no longer counts.
    const rebook = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${limitedEventId}/book`,
      headers: bearer('other'),
      payload: { lines: [{ tierId: slotBTierId, quantity: 2 }] },
    });
    expect(rebook.statusCode).toBe(200);
  });
});
