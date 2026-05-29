import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      padmin: { uid: 'fbuid_padmin_at', email: 'padmin_at@x.com' },
      owner:  { uid: 'fbuid_powner_at', email: 'powner_at@x.com' },
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

interface TenantListItem {
  id: string;
  name: string;
  slug: string;
  status: string;
  subscriptionStatus: string;
  createdAt: string;
  venueCount: number;
  bookingCount30d: number;
}
interface TenantListPage { rows: TenantListItem[]; nextCursor: string | null }

async function createTenantViaApi(app: FastifyInstance, token: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tenants',
    headers: bearer(token),
    payload: { name: `Co ${slug}`, slug },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { id: string }).id;
}

describe.skipIf(!runIntegration)('admin tenants endpoints', () => {
  let app: FastifyInstance;
  let adminUserId: string;
  const SUFFIX = Date.now();
  const slugA = `admin-a-${SUFFIX}`;
  const slugB = `admin-b-${SUFFIX}`;
  const PLATFORM_SLUG = `circls-internal-test-${SUFFIX}`;
  let prevSlug: string | undefined;
  let tenantAId: string;
  let tenantBId: string;
  let platformTenantId: string;

  beforeAll(async () => {
    // Override the env slug so getPlatformTenantId() finds the seeded row.
    // Zod parses env at import time, so we mutate process.env directly here.
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    // Provision the padmin user row via /v1/me
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('padmin') });
    expect(me.statusCode).toBe(200);
    adminUserId = (me.json() as { id: string }).id;

    // Insert a platform tenant whose slug matches the env override above
    const ptRows = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = ((ptRows as unknown as { id: string }[])[0]!).id;

    // Make padmin a manager of the platform tenant
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${adminUserId}::uuid, 'manager')
    `);

    tenantAId = await createTenantViaApi(app, 'owner', slugA);
    tenantBId = await createTenantViaApi(app, 'owner', slugB);
  });

  afterAll(async () => {
    // Clean up platform tenant membership + tenant row
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

  it('GET /v1/admin/tenants — lists with counts, newest first', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/tenants', headers: bearer('padmin') });
    expect(res.statusCode).toBe(200);
    const page = res.json() as TenantListPage;
    expect(page.rows.length).toBeGreaterThanOrEqual(2);

    // newest-first ordering
    const ts = page.rows.map((r) => r.createdAt);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]! <= ts[i - 1]!).toBe(true);
    }
    // counts present
    for (const r of page.rows) {
      expect(typeof r.venueCount).toBe('number');
      expect(typeof r.bookingCount30d).toBe('number');
    }
  });

  it('GET /v1/admin/tenants — paginates via cursor', async () => {
    const p1 = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants?limit=1',
      headers: bearer('padmin'),
    });
    expect(p1.statusCode).toBe(200);
    const page1 = p1.json() as TenantListPage;
    expect(page1.rows).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const p2 = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants?limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      headers: bearer('padmin'),
    });
    expect(p2.statusCode).toBe(200);
    const page2 = p2.json() as TenantListPage;
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0]!.id).not.toBe(page1.rows[0]!.id);
  });

  it('GET /v1/admin/tenants — q matches slug', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants?q=${slugA}`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    const page = res.json() as TenantListPage;
    expect(page.rows.some((r) => r.slug === slugA)).toBe(true);
  });

  it('GET /v1/admin/tenants/:id — returns tenant + members', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantAId}`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tenant: { id: string; slug: string }; members: Array<{ role: string }> };
    expect(body.tenant.id).toBe(tenantAId);
    expect(body.tenant.slug).toBe(slugA);
    expect(body.members.length).toBeGreaterThanOrEqual(1);
    expect(body.members.some((m) => m.role === 'owner')).toBe(true);
  });

  it('GET /v1/admin/tenants/:id — 404 on unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/00000000-0000-0000-0000-000000000000`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('tenant_not_found');
  });

  it('POST suspend → status=suspended + audit row written', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantAId}/suspend`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('suspended');

    const audit = await db.execute<Record<string, unknown>>(sql`
      SELECT action, actor_user_id FROM audit_log
       WHERE tenant_id = ${tenantAId} AND action = 'tenant.suspended'
       ORDER BY created_at DESC LIMIT 1
    `);
    const rows = audit as unknown as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0]!['actor_user_id']).toBe(adminUserId);
  });

  it('POST reactivate → status=active + audit row written', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/tenants/${tenantAId}/reactivate`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('active');

    const audit = await db.execute<Record<string, unknown>>(sql`
      SELECT action FROM audit_log
       WHERE tenant_id = ${tenantAId} AND action = 'tenant.reactivated'
       ORDER BY created_at DESC LIMIT 1
    `);
    expect((audit as unknown as Record<string, unknown>[]).length).toBe(1);
  });

  it('GET /v1/admin/stats — returns aggregate tile data', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: bearer('padmin') });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, number>;
    expect(typeof body['tenantsTotal']).toBe('number');
    expect(typeof body['tenantsActive']).toBe('number');
    expect(typeof body['tenantsSuspended']).toBe('number');
    expect(typeof body['bookings24h']).toBe('number');
    expect(typeof body['bookings7d']).toBe('number');
    expect(body['tenantsTotal']).toBeGreaterThanOrEqual(2);
  });

  it('non-admin caller gets 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/tenants', headers: bearer('owner') });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('tenant_forbidden');
  });

  // keep tenantB used so linter doesn't complain
  it('tenant B still listable', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantBId}`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
  });
});
