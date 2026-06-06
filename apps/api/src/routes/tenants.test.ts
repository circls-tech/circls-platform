import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_owner', email: 'owner@x.com', email_verified: true },
      other: { uid: 'fbuid_other', email: 'other@x.com', email_verified: true },
      admin: { uid: 'fbuid_admin', email: 'admin@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { __resetPlatformTenantCacheForTesting } = await import('../lib/authz/platform_tenant.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('tenants', () => {
  let app: FastifyInstance;
  let adminUserId: string;
  let platformTenantId: string;
  const SUFFIX = Date.now();
  const slug = `acme-${SUFFIX}`;
  const PLATFORM_SLUG = `circls-internal-test-tenants-${SUFFIX}`;
  let prevSlug: string | undefined;

  beforeAll(async () => {
    // Override the env slug so getPlatformTenantId() finds the seeded row.
    // Zod parses env at import time, so we mutate process.env directly here.
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    // Provision the admin user row
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('admin') });
    expect(me.statusCode).toBe(200);
    adminUserId = (me.json() as { id: string }).id;

    // Insert a platform tenant whose slug matches the env override above
    const ptRows = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = ((ptRows as unknown as { id: string }[])[0]!).id;

    // Make admin a manager of the platform tenant (manager has admin.tenants.read)
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${adminUserId}::uuid, 'manager')
    `);
  });

  afterAll(async () => {
    if (platformTenantId) {
      await db.execute(sql`DELETE FROM tenant_members WHERE tenant_id = ${platformTenantId}::uuid`);
      await db.execute(sql`DELETE FROM tenants WHERE id = ${platformTenantId}::uuid`);
    }
    // Restore the env slug override and flush the cache.
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug ?? 'circls-internal';
    __resetPlatformTenantCacheForTesting();
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

  it('GET /v1/tenants is admin-only (platform member gets 200, non-member gets 403)', async () => {
    const forbidden = await app.inject({ method: 'GET', url: '/v1/tenants', headers: bearer('owner') });
    expect(forbidden.statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: '/v1/tenants', headers: bearer('admin') });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.json())).toBe(true);
  });
});
