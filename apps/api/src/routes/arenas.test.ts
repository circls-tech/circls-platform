import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_aowner', email: 'aowner@x.com' },
      other: { uid: 'fbuid_aother', email: 'aother@x.com' },
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
    await closeDb();
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
