import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_bsowner', email: 'bsowner@x.com' },
      other: { uid: 'fbuid_bsother', email: 'bsother@x.com' },
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

describe.skipIf(!runIntegration)('slots + multi-slot bookings', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let arenaId: string;

  // After setup, the IDs of the open slots released for the test window.
  let openSlotIds: string[];

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // Create tenant + venue + arena (owner)
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Slots Co', slug: `sco-${Date.now()}` },
    });
    tenantId = t.json().id;

    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Slots Venue' },
    });
    venueId = v.json().id;

    const a = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Slot Arena', slotDurationMin: 60 },
    });
    arenaId = a.json().id;

    // Release a small grid: Tuesday 2027-06-01 (a Tuesday) — 3 x 60-min slots.
    const releaseRes = await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaId}/slots/release`,
      headers: withKey('owner', `rel-${Date.now()}`),
      payload: {
        startDate: '2027-06-01',
        endDate: '2027-06-01',
        quantizationMin: 60,
        cells: [
          { dayOfWeek: 2, startTimeMin: 360, durationMin: 60, price: 10000 }, // 06:00 IST
          { dayOfWeek: 2, startTimeMin: 420, durationMin: 60, price: 12000 }, // 07:00 IST
          { dayOfWeek: 2, startTimeMin: 480, durationMin: 60, price: 15000 }, // 08:00 IST
        ],
      },
    });
    expect(releaseRes.statusCode).toBe(200);
    expect(releaseRes.json().created).toBeGreaterThanOrEqual(3);

    // GET the released slots
    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=2027-06-01T00:00:00Z&to=2027-06-02T00:00:00Z`,
      headers: bearer('owner'),
    });
    expect(slotsRes.statusCode).toBe(200);
    const allSlots = slotsRes.json() as Array<{ id: string; status: string; pricePaise: number }>;
    openSlotIds = allSlots.filter((s) => s.status === 'open').map((s) => s.id);
    expect(openSlotIds.length).toBeGreaterThanOrEqual(3);
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  let bookingId: string;
  let bookedSlotIds: string[];

  it('books 2 slots — 201, totalPaise matches sum, slots become booked', async () => {
    bookedSlotIds = openSlotIds.slice(0, 2);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('owner', `bk1-${Date.now()}`),
      payload: {
        slotIds: bookedSlotIds,
        customer: { name: 'Alice', contact: '+91-9999900000' },
      },
    });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    bookingId = b.id;
    expect(b.status).toBe('confirmed');

    // Verify totalPaise is the sum
    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=2027-06-01T00:00:00Z&to=2027-06-02T00:00:00Z`,
      headers: bearer('owner'),
    });
    const allSlots = slotsRes.json() as Array<{ id: string; status: string; pricePaise: number }>;
    const expectedTotal = allSlots
      .filter((s) => bookedSlotIds.includes(s.id))
      .reduce((sum, s) => sum + s.pricePaise, 0);
    expect(b.totalPaise).toBe(expectedTotal);

    // Both slots should now be 'booked'
    const booked = allSlots.filter((s) => bookedSlotIds.includes(s.id));
    expect(booked.every((s) => s.status === 'booked')).toBe(true);
  });

  it('concurrency: booking the same slots twice yields exactly one 201 and one 409 slot_taken', async () => {
    // Use the 3rd remaining open slot (index 2)
    const raceSlotIds = [openSlotIds[2]!];

    // Fire both requests against the same app. Even though app.inject may
    // serialize at the HTTP layer, the DB transaction atomicity ensures only
    // one succeeds when the same slot is targeted.
    const [res1, res2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/bookings',
        headers: withKey('owner', `race1-${Date.now()}`),
        payload: { slotIds: raceSlotIds, customer: { name: 'Bob', contact: '1111' } },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/bookings',
        headers: withKey('owner', `race2-${Date.now()}`),
        payload: { slotIds: raceSlotIds, customer: { name: 'Carol', contact: '2222' } },
      }),
    ]);

    const statuses = [res1.statusCode, res2.statusCode].sort();
    // Exactly one 201 and one 409 — the DB-level update atomicity guarantees this.
    expect(statuses).toEqual([201, 409]);
    const failed = res1.statusCode === 409 ? res1 : res2;
    expect(failed.json().error.code).toBe('slot_taken');
  });

  it('non-member (other token) cannot book slots', async () => {
    // Pick any remaining open slot for the authz test (use a fresh extra release)
    const extraRelease = await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaId}/slots/release`,
      headers: withKey('owner', `relz-${Date.now()}`),
      payload: {
        startDate: '2027-06-08',
        endDate: '2027-06-08',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 2, startTimeMin: 600, durationMin: 60, price: 5000 }],
      },
    });
    expect(extraRelease.json().created).toBeGreaterThanOrEqual(1);

    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=2027-06-08T00:00:00Z&to=2027-06-09T00:00:00Z`,
      headers: bearer('owner'),
    });
    const extraSlots = slotsRes.json() as Array<{ id: string; status: string }>;
    const extraSlotId = extraSlots.find((s) => s.status === 'open')?.id;
    expect(extraSlotId).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('other', `bk-other-${Date.now()}`),
      payload: { slotIds: [extraSlotId!], customer: { name: 'Eve', contact: '000' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('cancel restores slots to open and allows re-booking', async () => {
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/cancel`,
      headers: bearer('owner'),
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe('cancelled');

    // Slots should be open again
    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=2027-06-01T00:00:00Z&to=2027-06-02T00:00:00Z`,
      headers: bearer('owner'),
    });
    const allSlots = slotsRes.json() as Array<{ id: string; status: string }>;
    const restored = allSlots.filter((s) => bookedSlotIds.includes(s.id));
    expect(restored.every((s) => s.status === 'open')).toBe(true);

    // Re-book them
    const rebook = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('owner', `bk-rebook-${Date.now()}`),
      payload: {
        slotIds: bookedSlotIds,
        customer: { name: 'Alice Again', contact: '+91-9999900001' },
      },
    });
    expect(rebook.statusCode).toBe(201);
  });

  it('bulk re-price a booked slot → 409 slot_locked', async () => {
    // bookedSlotIds are now re-booked from the previous test
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/slots/bulk',
      headers: bearer('owner'),
      payload: { slotIds: [bookedSlotIds[0]!], price: 99999 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('slot_locked');
  });
});
