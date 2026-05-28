import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Hand-rolled mock of api_keys_service.verifyApiKey so we can exercise the
// middleware without hitting Postgres. Importing the middleware after vi.mock()
// ensures the mocked module is wired in.
vi.mock('../services/api_keys_service.js', () => ({
  verifyApiKey: vi.fn(async (plaintext: string) => {
    if (plaintext === 'ck_test_VALIDVALIDVALIDVALIDVALIDVALID3') {
      return {
        id: '00000000-0000-7000-8000-000000000001',
        tenantId: '00000000-0000-7000-8000-000000000002',
        name: 'mock-key',
        keyHash: 'unused',
        keyPrefix: 'ck_test_VALI',
        role: 'write',
        scopes: [],
        status: 'active',
        lastUsedAt: null,
        createdAt: new Date(),
      };
    }
    if (plaintext === 'ck_test_PLATFORMPLATFORMPLATFORMPLAT') {
      return {
        id: '00000000-0000-7000-8000-000000000003',
        tenantId: null,
        name: 'platform-key',
        keyHash: 'unused',
        keyPrefix: 'ck_test_PLAT',
        role: 'admin',
        scopes: [],
        status: 'active',
        lastUsedAt: null,
        createdAt: new Date(),
      };
    }
    return null;
  }),
}));

const { requireApiKey } = await import('./require_api_key.js');
const { AppError } = await import('../lib/errors.js');

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.decorateRequest('apiKey', null);
  app.decorateRequest('apiTenantId', null);
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.httpStatus).send({ error: { code: err.code, message: err.message } });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: { code: 'internal_error', message: msg } });
  });
  app.get('/protected', { preHandler: requireApiKey }, async (req) => ({
    keyId: req.apiKey?.id ?? null,
    tenantId: req.apiTenantId ?? null,
  }));
  return app;
}

describe('requireApiKey', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('401 when Authorization header is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('api_key_required');
  });

  it('401 when the scheme is not Bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Basic abc' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('api_key_required');
  });

  it('401 when the token does not start with ck_', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer not-a-ck-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('api_key_invalid');
  });

  it('401 when verifyApiKey returns null', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer ck_test_doesnotexistxxxxxxxxxxxxxxxxx' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('api_key_invalid');
  });

  it('200 on a valid tenant-scoped key with apiKey + apiTenantId attached', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer ck_test_VALIDVALIDVALIDVALIDVALIDVALID3' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      keyId: '00000000-0000-7000-8000-000000000001',
      tenantId: '00000000-0000-7000-8000-000000000002',
    });
  });

  it('200 on a platform key with apiTenantId=null', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer ck_test_PLATFORMPLATFORMPLATFORMPLAT' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      keyId: '00000000-0000-7000-8000-000000000003',
      tenantId: null,
    });
  });
});
