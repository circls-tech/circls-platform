import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_vowner', email: 'vowner@x.com' },
      other: { uid: 'fbuid_vother', email: 'vother@x.com' },
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

describe.skipIf(!runIntegration)('venues', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Venue Co', slug: `vco-${Date.now()}` },
    });
    tenantId = t.json().id;
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('owner creates a venue under their tenant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Court House', lat: 21.1458, lng: 79.0882 },
    });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    venueId = v.id;
    expect(v.tenantId).toBe(tenantId);
    expect(v.tzName).toBe('Asia/Kolkata');
    expect(v.status).toBe('active');
  });

  it('blocks a non-member from creating or reading venues', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('other'),
      payload: { name: 'Sneaky' },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error.code).toBe('tenant_forbidden');

    const read = await app.inject({ method: 'GET', url: `/v1/venues/${venueId}`, headers: bearer('other') });
    expect(read.statusCode).toBe(403);
  });

  it('lists + fetches venues for members', async () => {
    const list = await app.inject({ method: 'GET', url: `/v1/tenants/${tenantId}/venues`, headers: bearer('owner') });
    expect(list.json().some((v: { id: string }) => v.id === venueId)).toBe(true);
    const get = await app.inject({ method: 'GET', url: `/v1/venues/${venueId}`, headers: bearer('owner') });
    expect(get.statusCode).toBe(200);
    expect(get.json().id).toBe(venueId);
  });

  it('soft-deletes via status patch', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/venues/${venueId}`,
      headers: bearer('owner'),
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('suspended');
  });

  it('creates a venue with tags and returns them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Tagged Venue', tags: ['indoor', 'premium', 'rooftop'] },
    });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.tags).toEqual(['indoor', 'premium', 'rooftop']);
  });

  it('creates a venue without tags and returns empty array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'No Tag Venue' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toEqual([]);
  });
});
