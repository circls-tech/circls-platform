import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      padmin:   { uid: 'fbuid_padmin_au', email: 'padmin_au@x.com', email_verified: true },
      owner:    { uid: 'fbuid_powner_au', email: 'powner_au@x.com', email_verified: true },
      consumer: { uid: 'fbuid_consumer_au', email: 'consumer_au@x.com', email_verified: true },
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

interface ConsumerRow {
  id: string;
  email: string | null;
  interests: string[];
  eventsBooked: number;
  totalBookings: number;
  eventsOpened: number;
  sessionCount: number;
  minutesInApp: number;
  loginCount: number;
  lastLoginAt: string | null;
  createdAt: string;
}
interface PartnerRow {
  userId: string;
  role: string;
  tenantSlug: string;
  teamSize: number;
}
interface Page<T> { rows: T[]; nextCursor: string | null }

describe.skipIf(!runIntegration)('admin user report endpoints', () => {
  let app: FastifyInstance;
  let adminUserId: string;
  let consumerUserId: string;
  const SUFFIX = Date.now();
  const slugA = `admin-users-a-${SUFFIX}`;
  const PLATFORM_SLUG = `circls-internal-test-au-${SUFFIX}`;
  let prevSlug: string | undefined;
  let tenantAId: string;
  let platformTenantId: string;

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('padmin') });
    expect(me.statusCode).toBe(200);
    adminUserId = (me.json() as { id: string }).id;

    const ptRows = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = ((ptRows as unknown as { id: string }[])[0]!).id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${adminUserId}::uuid, 'manager')
    `);

    // Partner tenant with 'owner' as its owner member. country/acceptTerms are
    // required on main; the branch's schema strips the extra keys, so this
    // payload works on both the branch and the PR merge ref CI tests.
    const created = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: `Co ${slugA}`, slug: slugA, country: 'India', acceptTerms: true },
    });
    expect(created.statusCode).toBe(200);
    tenantAId = (created.json() as { id: string }).id;

    // Consumer user with interests, a booking, activity across a session, and a login.
    const cme = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('consumer') });
    expect(cme.statusCode).toBe(200);
    consumerUserId = (cme.json() as { id: string }).id;
    await db.execute(sql`
      UPDATE users SET interests = ARRAY['tennis','music'] WHERE id = ${consumerUserId}::uuid
    `);
    await db.execute(sql`
      INSERT INTO bookings (tenant_id, item_type, channel, payment_method, status, customer_user_id)
      VALUES
        (${tenantAId}::uuid, 'event', 'circls', 'free', 'confirmed', ${consumerUserId}::uuid),
        (${tenantAId}::uuid, 'slot',  'circls', 'free', 'confirmed', ${consumerUserId}::uuid),
        (${tenantAId}::uuid, 'event', 'circls', 'free', 'cancelled', ${consumerUserId}::uuid)
    `);
    // One session spanning 10 minutes, viewing the same event twice.
    await db.execute(sql`
      INSERT INTO consumer_activity (user_id, session_id, event_type, item_type, item_id, client_ts, created_at)
      VALUES
        (${consumerUserId}::uuid, 's1', 'item_view', 'event', ${tenantAId}::uuid, now(), now() - interval '10 minutes'),
        (${consumerUserId}::uuid, 's1', 'item_view', 'event', ${tenantAId}::uuid, now(), now())
    `);
    const login = await app.inject({
      method: 'POST',
      url: '/v1/me/login',
      headers: bearer('consumer'),
      payload: { source: 'consumer' },
    });
    expect(login.statusCode).toBe(204);
  });

  afterAll(async () => {
    // consumerUserId is unset if beforeAll failed part-way; skip the dependent
    // cleanup instead of cascading a second (confusing) SQL error.
    if (consumerUserId) {
      await db.execute(sql`DELETE FROM login_events WHERE user_id = ${consumerUserId}::uuid`);
      await db.execute(sql`DELETE FROM consumer_activity WHERE user_id = ${consumerUserId}::uuid`);
      await db.execute(sql`DELETE FROM bookings WHERE customer_user_id = ${consumerUserId}::uuid`);
    }
    if (platformTenantId) {
      await db.execute(sql`DELETE FROM tenant_members WHERE tenant_id = ${platformTenantId}::uuid`);
      await db.execute(sql`DELETE FROM tenants WHERE id = ${platformTenantId}::uuid`);
    }
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug ?? 'circls-internal';
    __resetPlatformTenantCacheForTesting();
    await app.close();
    await closeDb();
  });

  it('GET /v1/admin/users/consumers — returns joined rollups', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/users/consumers?q=consumer_au%40x.com',
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    const page = res.json() as Page<ConsumerRow>;
    const row = page.rows.find((r) => r.id === consumerUserId);
    expect(row).toBeDefined();
    expect(row!.interests).toEqual(['tennis', 'music']);
    expect(row!.eventsBooked).toBe(1); // cancelled event booking excluded
    expect(row!.totalBookings).toBe(2);
    expect(row!.eventsOpened).toBe(1); // same event viewed twice → 1 distinct
    expect(row!.sessionCount).toBe(1);
    expect(row!.minutesInApp).toBe(10);
    expect(row!.loginCount).toBeGreaterThanOrEqual(1);
    expect(row!.lastLoginAt).not.toBeNull();
  });

  it('GET /v1/admin/users/consumers — newest first + cursor paginates', async () => {
    const p1 = await app.inject({
      method: 'GET',
      url: '/v1/admin/users/consumers?limit=1',
      headers: bearer('padmin'),
    });
    expect(p1.statusCode).toBe(200);
    const page1 = p1.json() as Page<ConsumerRow>;
    expect(page1.rows).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const p2 = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/consumers?limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      headers: bearer('padmin'),
    });
    expect(p2.statusCode).toBe(200);
    const page2 = p2.json() as Page<ConsumerRow>;
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0]!.id).not.toBe(page1.rows[0]!.id);
    expect(page2.rows[0]!.createdAt <= page1.rows[0]!.createdAt).toBe(true);
  });

  it('GET /v1/admin/users/consumers — since filters out older accounts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/consumers?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Page<ConsumerRow>).rows).toHaveLength(0);
  });

  it('GET /v1/admin/users/consumers?format=csv — downloads a CSV document', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/users/consumers?format=csv&q=consumer_au%40x.com',
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('consumer-users.csv');
    const body = res.body;
    expect(body.charCodeAt(0)).toBe(0xfeff);
    expect(body).toContain('"User ID","Name","Email"');
    expect(body).toContain('consumer_au@x.com');
    expect(body).toContain('tennis; music');
  });

  it('GET /v1/admin/users/partners — lists members of non-platform tenants only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/partners?q=${slugA}`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    const page = res.json() as Page<PartnerRow>;
    const row = page.rows.find((r) => r.tenantSlug === slugA);
    expect(row).toBeDefined();
    expect(row!.role).toBe('owner');
    expect(row!.teamSize).toBe(1);
    // Platform-tenant memberships (the admin) never appear.
    expect(page.rows.every((r) => r.userId !== adminUserId)).toBe(true);
  });

  it('GET /v1/admin/users/partners?format=csv — downloads a CSV document', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/partners?format=csv&q=${slugA}`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('partner-users.csv');
    expect(res.body).toContain(slugA);
  });

  it('rejects an invalid since parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/users/consumers?since=yesterday',
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('non-admin caller gets 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/users/consumers',
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(403);
  });
});
