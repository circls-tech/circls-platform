import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_bowner', email: 'bowner@x.com' },
      other: { uid: 'fbuid_bother', email: 'bother@x.com' },
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

describe.skipIf(!runIntegration)('walk-in bookings', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let arenaId: string;
  let bookingId: string;
  const slot = { startAt: '2026-07-01T10:00:00Z', endAt: '2026-07-01T11:00:00Z' };

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
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const payload = (extra: Record<string, unknown> = {}) => ({ tenantId, arenaId, ...slot, ...extra });

  it('requires an Idempotency-Key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/bookings', headers: bearer('owner'), payload: payload() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('idempotency_key_required');
  });

  it('creates a confirmed walk-in booking', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('owner', `k1-${Date.now()}`),
      payload: payload({ pricePaise: 50000 }),
    });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    bookingId = b.id;
    expect(b.channel).toBe('walkin');
    expect(b.paymentMethod).toBe('external');
    expect(b.status).toBe('confirmed');
  });

  it('rejects a double-booking with 409 slot_taken', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/bookings',
      headers: withKey('owner', `k2-${Date.now()}`),
      payload: payload(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('slot_taken');
  });

  it('is idempotent: same key returns the same booking', async () => {
    const key = `kdup-${Date.now()}`;
    const slot2 = { startAt: '2026-07-01T12:00:00Z', endAt: '2026-07-01T13:00:00Z' };
    const first = await app.inject({ method: 'POST', url: '/v1/bookings', headers: withKey('owner', key), payload: { tenantId, arenaId, ...slot2 } });
    const second = await app.inject({ method: 'POST', url: '/v1/bookings', headers: withKey('owner', key), payload: { tenantId, arenaId, ...slot2 } });
    expect(first.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
  });

  it('blocks a non-member', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/bookings', headers: withKey('other', `k3-${Date.now()}`), payload: payload() });
    expect(res.statusCode).toBe(403);
  });

  it('cancelling frees the slot for re-booking', async () => {
    const cancel = await app.inject({ method: 'POST', url: `/v1/bookings/${bookingId}/cancel`, headers: bearer('owner') });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe('cancelled');

    const rebook = await app.inject({ method: 'POST', url: '/v1/bookings', headers: withKey('owner', `k4-${Date.now()}`), payload: payload() });
    expect(rebook.statusCode).toBe(201);
  });
});
