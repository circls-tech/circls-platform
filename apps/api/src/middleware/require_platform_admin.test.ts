import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      admin: { uid: 'fbuid_padmin', email: 'padmin@x.com' },
      other: { uid: 'fbuid_pother', email: 'pother@x.com' },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { users } = await import('../db/schema/index.js');
const { eq } = await import('drizzle-orm');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('requirePlatformAdmin middleware', () => {
  let app: FastifyInstance;
  let adminUserId: string;
  const originalAllowlist = process.env['PLATFORM_ADMIN_USER_IDS'];

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // Provision the admin user (first call to /v1/me find-or-creates).
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('admin') });
    expect(me.statusCode).toBe(200);
    adminUserId = (me.json() as { id: string }).id;
    // also create the other user so it has a row before we hit /v1/admin/tenants
    await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('other') });
  });

  afterAll(async () => {
    if (originalAllowlist === undefined) delete process.env['PLATFORM_ADMIN_USER_IDS'];
    else process.env['PLATFORM_ADMIN_USER_IDS'] = originalAllowlist;
    await app.close();
    await closeDb();
  });

  beforeEach(() => {
    delete process.env['PLATFORM_ADMIN_USER_IDS'];
  });

  it('401 without bearer', async () => {
    process.env['PLATFORM_ADMIN_USER_IDS'] = adminUserId;
    const res = await app.inject({ method: 'GET', url: '/v1/admin/tenants' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('auth_required');
  });

  it('403 when allowlist is empty', async () => {
    process.env['PLATFORM_ADMIN_USER_IDS'] = '';
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: bearer('admin'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('platform_admin_required');
  });

  it('403 when user is not in allowlist', async () => {
    process.env['PLATFORM_ADMIN_USER_IDS'] = adminUserId;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: bearer('other'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('platform_admin_required');
  });

  it('200 when user is in allowlist', async () => {
    process.env['PLATFORM_ADMIN_USER_IDS'] = adminUserId;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants',
      headers: bearer('admin'),
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().rows)).toBe(true);
  });

  it('honours comma-separated allowlist with multiple ids', async () => {
    const otherUser = await db.query.users.findFirst({ where: eq(users.firebaseUid, 'fbuid_pother') });
    expect(otherUser).toBeTruthy();
    process.env['PLATFORM_ADMIN_USER_IDS'] = `${otherUser!.id},${adminUserId},00000000-0000-0000-0000-000000000000`;
    const r1 = await app.inject({ method: 'GET', url: '/v1/admin/tenants', headers: bearer('admin') });
    const r2 = await app.inject({ method: 'GET', url: '/v1/admin/tenants', headers: bearer('other') });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
  });
});
