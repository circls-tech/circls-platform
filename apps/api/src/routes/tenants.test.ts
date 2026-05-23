import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_owner', email: 'owner@x.com' },
      other: { uid: 'fbuid_other', email: 'other@x.com' },
      admin: { uid: 'fbuid_admin', email: 'admin@x.com', admin: true },
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

describe.skipIf(!runIntegration)('tenants', () => {
  let app: FastifyInstance;
  const slug = `acme-${Date.now()}`;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('owner creates a tenant and is auto-made owner', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Acme Sports', slug },
    });
    expect(res.statusCode).toBe(200);
    const t = res.json();
    expect(t.slug).toBe(slug);
    expect(t.status).toBe('active');
    expect(t.kycStatus).toBe('not_started');

    const mine = await app.inject({ method: 'GET', url: '/v1/me/tenants', headers: bearer('owner') });
    expect(mine.json().some((x: { slug: string }) => x.slug === slug)).toBe(true);
  });

  it('isolates tenants per user (other user sees none of it)', async () => {
    const other = await app.inject({ method: 'GET', url: '/v1/me/tenants', headers: bearer('other') });
    expect(other.json().some((x: { slug: string }) => x.slug === slug)).toBe(false);
  });

  it('rejects a duplicate slug with 409 slug_taken', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Dup', slug },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('slug_taken');
  });

  it('GET /v1/tenants is admin-only', async () => {
    const forbidden = await app.inject({ method: 'GET', url: '/v1/tenants', headers: bearer('owner') });
    expect(forbidden.statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: '/v1/tenants', headers: bearer('admin') });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.json())).toBe(true);
  });
});
