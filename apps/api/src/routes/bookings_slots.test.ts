import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_bsowner', email: 'bsowner@x.com' },
      ownerB: { uid: 'fbuid_bsownerb', email: 'bsownerb@x.com' },
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
    // Note: closeDb() is called by the cross-tenant suite's afterAll so the pool
    // remains open for tests that run after this describe block.
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

    // LIMITATION: app.inject() is a synchronous-ish in-process call; Fastify
    // serializes injected requests rather than truly running them concurrently.
    // As a result, the "race" here is resolved sequentially at the DB level —
    // the second transaction still sees 0 claimable rows (because the first
    // already flipped status to 'booked') and correctly throws slot_taken.
    // For a genuine parallel-connection race see the service-level test in
    // slot_service.test.ts which uses Promise.allSettled([bookSlots, bookSlots])
    // directly, exercising two concurrent DB transactions.
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

// ---------------------------------------------------------------------------
// Cross-tenant slot-claim security test
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('cross-tenant booking guard', () => {
  let app: FastifyInstance;

  // Tenant A (owner)
  let tenantAId: string;
  let arenaAId: string;
  let slotAId: string;

  // Tenant B (ownerB — a different user/owner)
  let tenantBId: string;
  let arenaBId: string;
  let slotBId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // --- Tenant A setup ---
    const tA = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Cross-Tenant A', slug: `cta-${Date.now()}` },
    });
    tenantAId = tA.json().id;

    const vA = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantAId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Venue A' },
    });
    const venueAId = vA.json().id;

    const aA = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueAId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Arena A', slotDurationMin: 60 },
    });
    arenaAId = aA.json().id;

    // 2029-03-04 is a Sunday (dayOfWeek 0) in IST; 08:00 IST = 02:30 UTC
    const relA = await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaAId}/slots/release`,
      headers: withKey('owner', `ctrel-a-${Date.now()}`),
      payload: {
        startDate: '2029-03-04',
        endDate: '2029-03-04',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 0, startTimeMin: 480, durationMin: 60, price: 10000 }],
      },
    });
    expect(relA.statusCode).toBe(200);
    expect(relA.json().created).toBeGreaterThanOrEqual(1);

    const slotsA = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaAId}/slots?from=2029-03-04T00:00:00Z&to=2029-03-05T00:00:00Z`,
      headers: bearer('owner'),
    });
    expect(slotsA.statusCode).toBe(200);
    slotAId = (slotsA.json() as Array<{ id: string; status: string }>)
      .find((s) => s.status === 'open')!.id;

    // --- Tenant B setup (different user: ownerB) ---
    const tB = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('ownerB'),
      payload: { name: 'Cross-Tenant B', slug: `ctb-${Date.now()}` },
    });
    tenantBId = tB.json().id;

    const vB = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantBId}/venues`,
      headers: bearer('ownerB'),
      payload: { name: 'Venue B' },
    });
    const venueBId = vB.json().id;

    const aB = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueBId}/arenas`,
      headers: bearer('ownerB'),
      payload: { name: 'Arena B', slotDurationMin: 60 },
    });
    arenaBId = aB.json().id;

    const relB = await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaBId}/slots/release`,
      headers: withKey('ownerB', `ctrel-b-${Date.now()}`),
      payload: {
        startDate: '2029-03-04',
        endDate: '2029-03-04',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 0, startTimeMin: 480, durationMin: 60, price: 20000 }],
      },
    });
    expect(relB.statusCode).toBe(200);
    expect(relB.json().created).toBeGreaterThanOrEqual(1);

    const slotsB = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaBId}/slots?from=2029-03-04T00:00:00Z&to=2029-03-05T00:00:00Z`,
      headers: bearer('ownerB'),
    });
    expect(slotsB.statusCode).toBe(200);
    slotBId = (slotsB.json() as Array<{ id: string; status: string }>)
      .find((s) => s.status === 'open')!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('tenant A owner cannot claim tenant B slot — 409 slot_taken, B slot stays open', async () => {
    // Owner of tenant A tries to book both their own slot AND a slot from tenant B.
    // The booking route resolves tenant from slot A (first slot), so the auth check passes.
    // The bookSlots UPDATE now includes eq(slots.tenantId, ctx.tenantId), so B's slot
    // is excluded from the UPDATE → claimed.length (1) !== slotIds.length (2) → 409.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('owner', `ct-attack-${Date.now()}`),
      payload: {
        slotIds: [slotAId, slotBId],
        customer: { name: 'Attacker', contact: '0000' },
      },
    });

    // The fix: B's slot won't be claimed → claimed.length < slotIds.length → 409 slot_taken.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('slot_taken');

    // Verify B's slot is still open (not booked by the cross-tenant request).
    const bSlots = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaBId}/slots?from=2029-03-04T00:00:00Z&to=2029-03-05T00:00:00Z`,
      headers: bearer('ownerB'),
    });
    const bSlot = (bSlots.json() as Array<{ id: string; status: string }>)
      .find((s) => s.id === slotBId);
    expect(bSlot?.status).toBe('open');
  });
});
