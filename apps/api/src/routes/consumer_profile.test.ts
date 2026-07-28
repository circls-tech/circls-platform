import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      profileuser: { uid: 'fbuid_profile_m2', email: 'profile_m2@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { sql } = await import('drizzle-orm');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('consumer profile (GET/PATCH /v1/consumer/me)', () => {
  let app: FastifyInstance;

  // The fixture uid is fixed, so drop any row a previous run left behind —
  // "creates-on-first-sight" must actually be first sight on persistent DBs.
  const dropFixture = async () =>
    db.execute(sql`delete from users where firebase_uid = 'fbuid_profile_m2'`);

  beforeAll(async () => {
    await dropFixture();
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await dropFixture();
    await app.close();
    await closeDb();
  });

  it('GET creates-on-first-sight and returns empty interests + null displayName', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('profileuser') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.email).toBe('profile_m2@x.com');
    expect(body.profile.interests).toEqual([]);
    expect(body.profile.displayName).toBeNull();
  });

  it('PATCH sets displayName + interests and they round-trip', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/consumer/me',
      headers: bearer('profileuser'),
      payload: { displayName: 'Vedant', interests: ['badminton', 'football'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.displayName).toBe('Vedant');
    expect(res.json().profile.interests).toEqual(['badminton', 'football']);

    const get = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('profileuser') });
    expect(get.json().profile.interests).toEqual(['badminton', 'football']);
  });

  it('PATCH rejects an invalid email with 400 bad_request', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/consumer/me',
      headers: bearer('profileuser'),
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('GET without a token is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/me' });
    expect(res.statusCode).toBe(401);
  });

  it('PATCH email stores it UNVERIFIED — self-reported, never an identity key', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/consumer/me',
      headers: bearer('profileuser'),
      payload: { email: 'self.reported.m2@x.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.email).toBe('self.reported.m2@x.com');

    const rows = await db.execute(
      sql`select email, email_verified from users where firebase_uid = 'fbuid_profile_m2'`,
    );
    expect(rows[0]).toMatchObject({ email: 'self.reported.m2@x.com', email_verified: false });
  });
});
