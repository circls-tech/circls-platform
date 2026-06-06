import type { FastifyInstance } from 'fastify';
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

const { closeDb } = await import('../db/client.js');
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

    // Release one slot (Wednesday 2026-07-01 is a Wednesday)
    await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaId}/slots/release`,
      headers: withKey('owner', `setup-${Date.now()}`),
      payload: {
        startDate: '2026-07-01',
        endDate: '2026-07-01',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 3, startTimeMin: 600, durationMin: 60, price: 50000 }], // 10:00 Wed
      },
    });

    // Grab the slot id
    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=2026-07-01T00:00:00Z&to=2026-07-02T00:00:00Z`,
      headers: bearer('owner'),
    });
    const slots = slotsRes.json() as Array<{ id: string; status: string }>;
    slotId = slots.find((s) => s.status === 'open')!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
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
    // Release an extra slot on Thursday 2026-07-02
    const relRes = await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaId}/slots/release`,
      headers: withKey('owner', `setup2-${Date.now()}`),
      payload: {
        startDate: '2026-07-02',
        endDate: '2026-07-02',
        quantizationMin: 60,
        cells: [{ dayOfWeek: 4, startTimeMin: 600, durationMin: 60, price: 20000 }], // 10:00 Thu
      },
    });
    expect(relRes.statusCode).toBe(200);

    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=2026-07-02T00:00:00Z&to=2026-07-03T00:00:00Z`,
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
