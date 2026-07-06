import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      profileuser: { uid: 'fbuid_profile_m2', email: 'profile_m2@x.com', email_verified: true },
      otheruser: { uid: 'fbuid_profile_other', email: 'profile_other@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { users } = await import('../db/schema/users.js');
const { inArray } = await import('drizzle-orm');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('consumer profile (GET/PATCH /v1/consumer/me)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    // The sandbox DB persists between runs — drop this suite's fixture users so
    // create-on-first-sight and uniqueness assertions start from a clean slate.
    await db
      .delete(users)
      .where(inArray(users.firebaseUid, ['fbuid_profile_m2', 'fbuid_profile_other']));
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('GET creates-on-first-sight and returns empty interests + null displayName/username', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('profileuser') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.email).toBe('profile_m2@x.com');
    expect(body.profile.interests).toEqual([]);
    expect(body.profile.displayName).toBeNull();
    expect(body.profile.username).toBeNull();
  });

  it('PATCH sets displayName + interests and they round-trip', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/consumer/me',
      headers: bearer('profileuser'),
      payload: { displayName: 'Vedant', interests: ['sports', 'music'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.displayName).toBe('Vedant');
    expect(res.json().profile.interests).toEqual(['sports', 'music']);

    const get = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('profileuser') });
    expect(get.json().profile.interests).toEqual(['sports', 'music']);
  });

  it('PATCH rejects an interest outside the canonical list with 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/consumer/me',
      headers: bearer('profileuser'),
      payload: { interests: ['sports', 'underwater-basket-weaving'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('PATCH sets a username, lowercases it, and it round-trips', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/consumer/me',
      headers: bearer('profileuser'),
      payload: { username: 'Vedant_99' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.username).toBe('vedant_99');

    const get = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('profileuser') });
    expect(get.json().profile.username).toBe('vedant_99');
  });

  it('PATCH rejects invalid usernames with 400', async () => {
    for (const username of ['ab', 'has space', 'dash-not-ok', '_leading', 'x'.repeat(31)]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/consumer/me',
        headers: bearer('profileuser'),
        payload: { username },
      });
      expect(res.statusCode, `username=${username}`).toBe(400);
    }
  });

  it('a second user cannot take the same username (case-insensitive) → 409 username_taken', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/consumer/me',
      headers: bearer('otheruser'),
      payload: { username: 'VEDANT_99' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('username_taken');
  });

  it('username-available reflects taken vs free, and own username counts as available', async () => {
    const taken = await app.inject({
      method: 'GET',
      url: '/v1/consumer/me/username-available?username=vedant_99',
      headers: bearer('otheruser'),
    });
    expect(taken.statusCode).toBe(200);
    expect(taken.json()).toEqual({ available: false, valid: true });

    const own = await app.inject({
      method: 'GET',
      url: '/v1/consumer/me/username-available?username=Vedant_99',
      headers: bearer('profileuser'),
    });
    expect(own.json()).toEqual({ available: true, valid: true });

    const free = await app.inject({
      method: 'GET',
      url: '/v1/consumer/me/username-available?username=definitely_free_9',
      headers: bearer('otheruser'),
    });
    expect(free.json()).toEqual({ available: true, valid: true });

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/consumer/me/username-available?username=a',
      headers: bearer('otheruser'),
    });
    expect(invalid.json()).toEqual({ available: false, valid: false });
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
});
