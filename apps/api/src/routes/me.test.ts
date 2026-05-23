import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Mock the Firebase verifier so the route can be exercised without a real
// project: token "good" → a fixed identity, anything else → throw.
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    if (token === 'good') {
      return { uid: 'fbuid_test_1', email: 'me@example.com', phone_number: null };
    }
    throw new Error('invalid token');
  }),
}));

const { closeDb } = await import('../db/client.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('GET /v1/me', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('returns 401 auth_required without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('auth_required');
  });

  it('find-or-creates the user and is idempotent', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer good' },
    });
    expect(first.statusCode).toBe(200);
    const u1 = first.json();
    expect(u1.firebaseUid).toBe('fbuid_test_1');
    expect(u1.email).toBe('me@example.com');

    const second = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer good' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(u1.id);
  });
});
