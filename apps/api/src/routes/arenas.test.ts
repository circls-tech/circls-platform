import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_aowner', email: 'aowner@x.com' },
      other: { uid: 'fbuid_aother', email: 'aother@x.com' },
      // separate user for arena-read tenant-isolation tests
      arOwner: { uid: 'fbuid_arowner', email: 'arowner@x.com' },
      arOther: { uid: 'fbuid_arother', email: 'arother@x.com' },
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

describe.skipIf(!runIntegration)('arenas + schedule', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let arenaId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Arena Co', slug: `aco-${Date.now()}` },
    });
    tenantId = t.json().id;
    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Hall' },
    });
    venueId = v.json().id;
  });
  afterAll(async () => {
    await app.close();
    // closeDb deferred to the GET /v1/arenas/:arenaId suite below
  });

  it('creates an arena under a venue', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Court 1', sport: 'badminton', slotDurationMin: 60 },
    });
    expect(res.statusCode).toBe(200);
    arenaId = res.json().id;
    expect(res.json().venueId).toBe(venueId);
  });

  it('blocks a non-member from creating arenas', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('other'),
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('sets and reads the weekly schedule', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/arenas/${arenaId}/schedule`,
      headers: bearer('owner'),
      payload: {
        rows: [
          { dayOfWeek: 6, startTime: '06:00', endTime: '22:00', slotDurationMin: 60 },
          { dayOfWeek: 0, startTime: '08:00', endTime: '20:00' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().length).toBe(2);
    const get = await app.inject({ method: 'GET', url: `/v1/arenas/${arenaId}/schedule`, headers: bearer('owner') });
    expect(get.json().length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/arenas/:arenaId — tenant-scoped read endpoint
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('GET /v1/arenas/:arenaId', () => {
  let app: FastifyInstance;
  let venueId: string;
  let arenaId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // Seed: arOwner creates tenant → venue → arena
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('arOwner'),
      payload: { name: 'Arena Read Co', slug: `arco-${Date.now()}` },
    });
    const tenantId: string = t.json().id;

    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('arOwner'),
      payload: { name: 'Read Hall' },
    });
    venueId = v.json().id;

    const a = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('arOwner'),
      payload: { name: 'Main Court', sport: 'tennis', slotDurationMin: 60 },
    });
    arenaId = a.json().id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('returns 200 with arena id, name, and venueId for a tenant member', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}`,
      headers: bearer('arOwner'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(arenaId);
    expect(body.name).toBe('Main Court');
    expect(body.venueId).toBe(venueId);
  });

  it('returns 403 for a user who is not a member of the arena tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}`,
      headers: bearer('arOther'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 with arena_not_found for an unknown arenaId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/arenas/00000000-0000-0000-0000-000000000099',
      headers: bearer('arOwner'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('arena_not_found');
  });
});
