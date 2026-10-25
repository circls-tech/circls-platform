import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      padmin: { uid: 'fbuid_padmin_at', email: 'padmin_at@x.com', email_verified: true },
      owner:  { uid: 'fbuid_powner_at', email: 'powner_at@x.com', email_verified: true },
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
  sales30d: number;
}
interface TenantListPage { rows: TenantListItem[]; nextCursor: string | null }

async function createTenantViaApi(app: FastifyInstance, token: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tenants',
    headers: bearer(token),
    payload: { name: `Co ${slug}`, slug, country: 'India', acceptTerms: true },
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
      expect(typeof r.sales30d).toBe('number');
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

  it('GET /v1/admin/tenants — defaults to active; status filter opts in', async () => {
    await db.execute(sql`UPDATE tenants SET status = 'suspended' WHERE id = ${tenantBId}::uuid`);
    try {
      const def = await app.inject({
        method: 'GET',
        url: '/v1/admin/tenants?limit=200',
        headers: bearer('padmin'),
      });
      const defPage = def.json() as TenantListPage;
      expect(defPage.rows.some((r) => r.id === tenantBId)).toBe(false);
      expect(defPage.rows.some((r) => r.id === tenantAId)).toBe(true);

      const susp = await app.inject({
        method: 'GET',
        url: '/v1/admin/tenants?limit=200&status=suspended',
        headers: bearer('padmin'),
      });
      const suspPage = susp.json() as TenantListPage;
      expect(suspPage.rows.some((r) => r.id === tenantBId)).toBe(true);
      expect(suspPage.rows.every((r) => r.status === 'suspended')).toBe(true);

      const all = await app.inject({
        method: 'GET',
        url: '/v1/admin/tenants?limit=200&status=all',
        headers: bearer('padmin'),
      });
      const allPage = all.json() as TenantListPage;
      expect(allPage.rows.some((r) => r.id === tenantBId)).toBe(true);
      expect(allPage.rows.some((r) => r.id === tenantAId)).toBe(true);
    } finally {
      await db.execute(sql`UPDATE tenants SET status = 'active' WHERE id = ${tenantBId}::uuid`);
    }
  });

  it('GET /v1/admin/tenants — sales30d counts bookings that stand and free sign-ups; minSales30d filters on it', async () => {
    // B sells one booking; its abandoned checkout and cancelled booking are
    // not sales.
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO bookings (tenant_id, item_type, channel, payment_method, status, item_data)
      VALUES (${tenantBId}::uuid, 'event', 'circls', 'free', 'confirmed', '{}'::jsonb),
             (${tenantBId}::uuid, 'event', 'circls', 'free', 'pending',   '{}'::jsonb),
             (${tenantBId}::uuid, 'event', 'circls', 'free', 'cancelled', '{}'::jsonb)
      RETURNING id
    `);
    const ids = (inserted as unknown as { id: string }[]).map((r) => r.id);
    // And one free plan sign-up, which writes no booking.
    const plan = await db.execute<{ id: string }>(sql`
      INSERT INTO memberships (tenant_id, name, duration_days, price_paise, status)
      VALUES (${tenantBId}::uuid, 'Free Sales Plan', 30, 0, 'active')
      RETURNING id
    `);
    const planId = (plan as unknown as { id: string }[])[0]!.id;
    await db.execute(sql`
      INSERT INTO user_memberships (membership_id, user_id, starts_at, ends_at, status)
      VALUES (${planId}::uuid, ${adminUserId}::uuid, now(), now() + interval '30 days', 'active')
    `);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/tenants?limit=200&minSales30d=1',
        headers: bearer('padmin'),
      });
      expect(res.statusCode).toBe(200);
      const page = res.json() as TenantListPage;
      // A has sold nothing.
      expect(page.rows.some((r) => r.id === tenantAId)).toBe(false);
      expect(page.rows.find((r) => r.id === tenantBId)?.sales30d).toBe(2);
      expect(page.rows.every((r) => r.sales30d >= 1)).toBe(true);
    } finally {
      await db.execute(sql`DELETE FROM bookings WHERE id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
      await db.execute(sql`DELETE FROM user_memberships WHERE membership_id = ${planId}::uuid`);
      await db.execute(sql`DELETE FROM memberships WHERE id = ${planId}::uuid`);
    }
  });

  it('GET /v1/admin/tenants — sort=created_asc reverses order and pages forwards', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants?limit=200&sort=created_asc',
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    const ts = (res.json() as TenantListPage).rows.map((r) => r.createdAt);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]! >= ts[i - 1]!).toBe(true);
    }

    // The keyset cursor has to follow the direction, or page 2 repeats page 1.
    const p1 = await app.inject({
      method: 'GET',
      url: '/v1/admin/tenants?limit=1&sort=created_asc',
      headers: bearer('padmin'),
    });
    const page1 = p1.json() as TenantListPage;
    expect(page1.nextCursor).not.toBeNull();
    const p2 = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants?limit=1&sort=created_asc&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      headers: bearer('padmin'),
    });
    const page2 = p2.json() as TenantListPage;
    expect(page2.rows).toHaveLength(1);
    expect(page2.rows[0]!.id).not.toBe(page1.rows[0]!.id);
    expect(page2.rows[0]!.createdAt >= page1.rows[0]!.createdAt).toBe(true);
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
    expect(typeof body['sales24h']).toBe('number');
    expect(typeof body['sales7d']).toBe('number');
    expect(typeof body['usersTotal']).toBe('number');
    expect(typeof body['usersNew24h']).toBe('number');
    expect(typeof body['usersNew7d']).toBe('number');
    expect(typeof body['activeUsers24h']).toBe('number');
    expect(typeof body['activeUsers30d']).toBe('number');
    expect(typeof body['logins24h']).toBe('number');
    expect(typeof body['logins7d']).toBe('number');
    expect(body['tenantsTotal']).toBeGreaterThanOrEqual(2);
    expect(body['usersTotal']).toBeGreaterThanOrEqual(1);
  });

  it('POST /v1/me/login — records a login that shows in stats', async () => {
    const before = (
      await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: bearer('padmin') })
    ).json() as Record<string, number>;

    const rec = await app.inject({
      method: 'POST',
      url: '/v1/me/login',
      headers: bearer('padmin'),
      payload: { source: 'admin' },
    });
    expect(rec.statusCode).toBe(204);

    const after = (
      await app.inject({ method: 'GET', url: '/v1/admin/stats', headers: bearer('padmin') })
    ).json() as Record<string, number>;
    expect(after['logins24h']).toBeGreaterThan(before['logins24h']!);
    expect(after['logins7d']).toBeGreaterThan(before['logins7d']!);
  });

  /**
   * Both active-user tiles used to count consumer_activity, a table no client
   * has ever written to, so they read 0 from the day they shipped. They now
   * count people who signed in or booked.
   */
  describe('active users', () => {
    async function stats(): Promise<Record<string, number>> {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/stats',
        headers: bearer('padmin'),
      });
      expect(res.statusCode).toBe(200);
      return res.json() as Record<string, number>;
    }

    it('counts a fresh sign-in', async () => {
      const before = await stats();
      const [u] = (await db.execute<Record<string, unknown>>(sql`
        INSERT INTO users (firebase_uid, email)
        VALUES (${`act-login-${Date.now()}`}, ${`act-login-${Date.now()}@x.com`})
        RETURNING id
      `)) as unknown as Record<string, unknown>[];
      await db.execute(sql`
        INSERT INTO login_events (user_id, source) VALUES (${u!['id'] as string}::uuid, 'consumer')
      `);
      const after = await stats();
      expect(after['activeUsers24h']).toBe(before['activeUsers24h']! + 1);
      expect(after['activeUsers30d']).toBe(before['activeUsers30d']! + 1);
    });

    it('counts someone who booked without signing in again', async () => {
      // The case login_events alone misses: signed in weeks ago, never signed
      // out, booked today. login_events records fresh sign-ins only.
      const before = await stats();
      const [u] = (await db.execute<Record<string, unknown>>(sql`
        INSERT INTO users (firebase_uid, email)
        VALUES (${`act-book-${Date.now()}`}, ${`act-book-${Date.now()}@x.com`})
        RETURNING id
      `)) as unknown as Record<string, unknown>[];
      await db.execute(sql`
        INSERT INTO bookings (tenant_id, item_type, channel, payment_method, status, customer_user_id)
        VALUES (${tenantAId}::uuid, 'event', 'circls', 'free', 'confirmed', ${u!['id'] as string}::uuid)
      `);
      const after = await stats();
      expect(after['activeUsers24h']).toBe(before['activeUsers24h']! + 1);
    });

    it('counts a person once however many times they appear', async () => {
      const before = await stats();
      const [u] = (await db.execute<Record<string, unknown>>(sql`
        INSERT INTO users (firebase_uid, email)
        VALUES (${`act-both-${Date.now()}`}, ${`act-both-${Date.now()}@x.com`})
        RETURNING id
      `)) as unknown as Record<string, unknown>[];
      const id = u!['id'] as string;
      await db.execute(sql`
        INSERT INTO login_events (user_id, source) VALUES (${id}::uuid, 'consumer'), (${id}::uuid, 'consumer')
      `);
      await db.execute(sql`
        INSERT INTO bookings (tenant_id, item_type, channel, payment_method, status, customer_user_id)
        VALUES (${tenantAId}::uuid, 'event', 'circls', 'free', 'confirmed', ${id}::uuid)
      `);
      const after = await stats();
      expect(after['activeUsers24h']).toBe(before['activeUsers24h']! + 1);
    });

    it('drops someone who has since deleted their account', async () => {
      // Deletion wipes that person's consumer_activity but leaves their logins
      // and their bookings' customer_user_id behind, so without the tombstone
      // check they would keep counting for a month after asking to be forgotten.
      const before = await stats();
      const [u] = (await db.execute<Record<string, unknown>>(sql`
        INSERT INTO users (firebase_uid, email)
        VALUES (${`act-gone-${Date.now()}`}, ${`act-gone-${Date.now()}@x.com`})
        RETURNING id
      `)) as unknown as Record<string, unknown>[];
      const id = u!['id'] as string;
      await db.execute(sql`
        INSERT INTO login_events (user_id, source) VALUES (${id}::uuid, 'consumer')
      `);
      await db.execute(sql`
        INSERT INTO bookings (tenant_id, item_type, channel, payment_method, status, customer_user_id)
        VALUES (${tenantAId}::uuid, 'event', 'circls', 'free', 'confirmed', ${id}::uuid)
      `);
      expect((await stats())['activeUsers24h']).toBe(before['activeUsers24h']! + 1);

      await db.execute(sql`UPDATE users SET deleted_at = now() WHERE id = ${id}::uuid`);
      const after = await stats();
      expect(after['activeUsers24h']).toBe(before['activeUsers24h']!);
      expect(after['activeUsers30d']).toBe(before['activeUsers30d']!);
    });

    it('ignores what happened before the window', async () => {
      const before = await stats();
      const [u] = (await db.execute<Record<string, unknown>>(sql`
        INSERT INTO users (firebase_uid, email)
        VALUES (${`act-old-${Date.now()}`}, ${`act-old-${Date.now()}@x.com`})
        RETURNING id
      `)) as unknown as Record<string, unknown>[];
      await db.execute(sql`
        INSERT INTO login_events (user_id, source, created_at)
        VALUES (${u!['id'] as string}::uuid, 'consumer', now() - interval '31 days')
      `);
      const after = await stats();
      expect(after['activeUsers24h']).toBe(before['activeUsers24h']!);
      expect(after['activeUsers30d']).toBe(before['activeUsers30d']!);
    });
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

  // ── Billing knobs ──────────────────────────────────────────────────────────

  it('PATCH billing — sets all five knobs + writes an audit row', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantAId}/billing`,
      headers: bearer('padmin'),
      payload: {
        commissionBps: 500,
        consumerCommissionBps: 200,
        customerFeeShareBps: 5000,
        orgFeeShareBps: 3000,
        advancePayoutBps: 2500,
      },
    });
    expect(res.statusCode).toBe(200);
    const t = res.json() as Record<string, number>;
    expect(t['commissionBps']).toBe(500);
    expect(t['consumerCommissionBps']).toBe(200);
    expect(t['customerFeeShareBps']).toBe(5000);
    expect(t['orgFeeShareBps']).toBe(3000);
    expect(t['advancePayoutBps']).toBe(2500);

    const audit = await db.execute<Record<string, unknown>>(sql`
      SELECT action, actor_user_id, after FROM audit_log
       WHERE tenant_id = ${tenantAId} AND action = 'tenant.billing_updated'
       ORDER BY created_at DESC LIMIT 1
    `);
    const rows = audit as unknown as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0]!['actor_user_id']).toBe(adminUserId);
  });

  it('PATCH billing — partial patch keeps the other knobs untouched', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantAId}/billing`,
      headers: bearer('padmin'),
      payload: { consumerCommissionBps: 150 },
    });
    expect(res.statusCode).toBe(200);
    const t = res.json() as Record<string, number>;
    expect(t['consumerCommissionBps']).toBe(150);
    expect(t['commissionBps']).toBe(500);
    expect(t['customerFeeShareBps']).toBe(5000);
    expect(t['orgFeeShareBps']).toBe(3000);
    expect(t['advancePayoutBps']).toBe(2500);
  });

  it('PATCH billing — a merged split over 100% is rejected', async () => {
    // customer share is 5000 from the earlier patch; org 5001 would overflow.
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantAId}/billing`,
      headers: bearer('padmin'),
      payload: { orgFeeShareBps: 5001 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('fee_share_split_exceeds_total');
  });

  it('PATCH billing — empty patch and out-of-range bps are rejected', async () => {
    const empty = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantAId}/billing`,
      headers: bearer('padmin'),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const range = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantAId}/billing`,
      headers: bearer('padmin'),
      payload: { commissionBps: 10001 },
    });
    expect(range.statusCode).toBe(400);
  });

  it('PATCH billing — non-admin caller gets 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantAId}/billing`,
      headers: bearer('owner'),
      payload: { commissionBps: 100 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('commission-free period — not started by default; admin dates reach detail and list', async () => {
    const detail = () =>
      app.inject({ method: 'GET', url: `/v1/admin/tenants/${tenantBId}`, headers: bearer('padmin') });
    const before = await detail();
    expect(before.statusCode).toBe(200);
    expect(before.json().commissionWaiver).toMatchObject({
      status: 'not_started',
      startsOn: null,
      endsOn: null,
      firstPaidOn: null,
      afterWaiverBps: null,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantBId}/billing`,
      headers: bearer('padmin'),
      payload: { commissionWaiverStartsOn: '2026-01-10', commissionAfterWaiverBps: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      commissionWaiverStartsOn: '2026-01-10',
      commissionWaiverEndsOn: null,
      commissionAfterWaiverBps: 500,
      // Record-only: the live rate is untouched.
      commissionBps: 0,
    });

    // The default end follows the set start; long past, so ended.
    expect((await detail()).json().commissionWaiver).toMatchObject({
      status: 'ended',
      startsOn: '2026-01-10',
      endsOn: '2026-04-10',
      startSetByAdmin: true,
      endSetByAdmin: false,
      afterWaiverBps: 500,
    });

    const list = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants?q=${slugB}`,
      headers: bearer('padmin'),
    });
    expect(list.statusCode).toBe(200);
    const row = (list.json() as { rows: Array<{ id: string; commissionWaiver: unknown }> }).rows.find(
      (r) => r.id === tenantBId,
    );
    expect(row?.commissionWaiver).toMatchObject({ status: 'ended', endsOn: '2026-04-10' });

    const audit = (await db.execute<Record<string, unknown>>(sql`
      SELECT after FROM audit_log
       WHERE tenant_id = ${tenantBId} AND action = 'tenant.billing_updated'
       ORDER BY created_at DESC LIMIT 1
    `)) as unknown as Record<string, unknown>[];
    expect(audit[0]!['after']).toMatchObject({
      commissionWaiverStartsOn: '2026-01-10',
      commissionAfterWaiverBps: 500,
    });
  });

  it('commission-free period — rejects an end before the start and a non-date; null resets', async () => {
    const patch = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: `/v1/admin/tenants/${tenantBId}/billing`,
        headers: bearer('padmin'),
        payload,
      });

    // Start is 2026-01-10 from the previous test.
    const early = await patch({ commissionWaiverEndsOn: '2026-01-09' });
    expect(early.statusCode).toBe(400);
    expect(early.json().error.code).toBe('commission_waiver_ends_before_start');

    expect((await patch({ commissionWaiverStartsOn: '2026-02-31' })).statusCode).toBe(400);
    expect((await patch({ commissionWaiverStartsOn: '10/01/2026' })).statusCode).toBe(400);
    expect((await patch({ commissionAfterWaiverBps: 10001 })).statusCode).toBe(400);

    const reset = await patch({
      commissionWaiverStartsOn: null,
      commissionWaiverEndsOn: null,
      commissionAfterWaiverBps: null,
    });
    expect(reset.statusCode).toBe(200);
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantBId}`,
      headers: bearer('padmin'),
    });
    expect(detail.json().commissionWaiver).toMatchObject({ status: 'not_started', startsOn: null });
  });

  it('commission-free period — an end before the first paid booking is rejected', async () => {
    // tenantB's first paid booking: 06:00 UTC on 1 Mar 2026 (11:30 IST).
    const [b] = (await db.execute<Record<string, unknown>>(sql`
      INSERT INTO bookings (tenant_id, item_type, channel, payment_method, status,
                            item_data, currency, total_paise, created_at)
      VALUES (${tenantBId}::uuid, 'event', 'circls', 'razorpay_route', 'confirmed',
              '{}'::jsonb, 'INR', 10000, '2026-03-01T06:00:00Z')
      RETURNING id
    `)) as unknown as Record<string, unknown>[];
    await db.execute(sql`
      INSERT INTO payments (booking_id, tenant_id, provider, amount_paise, currency,
                            status, kind, settlement_hold_until, created_at)
      VALUES (${b!['id'] as string}::uuid, ${tenantBId}::uuid, 'stub', 10000, 'INR',
              'captured', 'charge', '2026-03-02T06:00:00Z', '2026-03-01T06:00:00Z')
    `);

    const early = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantBId}/billing`,
      headers: bearer('padmin'),
      payload: { commissionWaiverEndsOn: '2026-02-01' },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().error.code).toBe('commission_waiver_ends_before_start');

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantBId}`,
      headers: bearer('padmin'),
    });
    expect(detail.json().commissionWaiver).toMatchObject({
      firstPaidOn: '2026-03-01',
      startsOn: '2026-03-01',
      endsOn: '2026-06-01',
      endSetByAdmin: false,
      months: 3,
    });
  });

  it('per-event billing overrides — list, set, clear', async () => {
    // Standalone (venue-less) event: the scope CHECK requires address + tz.
    const evRows = await db.execute<{ id: string }>(sql`
      INSERT INTO events (tenant_id, name, starts_at, ends_at, status, address_json, tz_name)
      VALUES (${tenantAId}::uuid, 'Billing Override Event', now() + interval '7 days',
              now() + interval '7 days 2 hours', 'published', '{"city":"Nagpur"}'::jsonb, 'Asia/Kolkata')
      RETURNING id
    `);
    const eventId = ((evRows as unknown as { id: string }[])[0]!).id;
    const chargingCount = async () =>
      (
        (
          await app.inject({
            method: 'GET',
            url: `/v1/admin/tenants/${tenantAId}`,
            headers: bearer('padmin'),
          })
        ).json() as { eventsChargingCommission: number }
      ).eventsChargingCommission;
    const chargingBefore = await chargingCount();

    // Listed with NULL overrides (inherit).
    const list = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantAId}/events`,
      headers: bearer('padmin'),
    });
    expect(list.statusCode).toBe(200);
    const listed = (list.json() as { rows: Array<Record<string, unknown>> }).rows;
    const row = listed.find((r) => r['id'] === eventId);
    expect(row).toBeDefined();
    expect(row!['partnerCommissionBps']).toBeNull();

    // Set two overrides; 0 is a real "disabled" override.
    const set = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/events/${eventId}/billing`,
      headers: bearer('padmin'),
      payload: { partnerCommissionBps: 100, consumerCommissionBps: 0 },
    });
    expect(set.statusCode).toBe(200);
    const setBody = set.json() as Record<string, unknown>;
    expect(setBody['partnerCommissionBps']).toBe(100);
    expect(setBody['consumerCommissionBps']).toBe(0);
    expect(setBody['advancePayoutBps']).toBeNull();
    // A live event charging partner commission is what the waiver warning counts.
    expect(await chargingCount()).toBe(chargingBefore + 1);

    const audit = await db.execute<Record<string, unknown>>(sql`
      SELECT action FROM audit_log
       WHERE tenant_id = ${tenantAId} AND action = 'event.billing_updated'
       ORDER BY created_at DESC LIMIT 1
    `);
    expect((audit as unknown as Record<string, unknown>[]).length).toBe(1);

    // Explicit null clears back to inherit.
    const clear = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/events/${eventId}/billing`,
      headers: bearer('padmin'),
      payload: { partnerCommissionBps: null },
    });
    expect(clear.statusCode).toBe(200);
    expect((clear.json() as Record<string, unknown>)['partnerCommissionBps']).toBeNull();
    // The untouched override survives.
    expect((clear.json() as Record<string, unknown>)['consumerCommissionBps']).toBe(0);
    expect(await chargingCount()).toBe(chargingBefore);

    await db.execute(sql`DELETE FROM events WHERE id = ${eventId}::uuid`);
  });

  it('per-event billing — non-admin gets 403, unknown event 404', async () => {
    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/events/00000000-0000-0000-0000-000000000000/billing`,
      headers: bearer('owner'),
      payload: { partnerCommissionBps: 100 },
    });
    expect(forbidden.statusCode).toBe(403);

    const missing = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/events/00000000-0000-0000-0000-000000000000/billing`,
      headers: bearer('padmin'),
      payload: { partnerCommissionBps: 100 },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('billing reset for cleanliness', async () => {
    // Zero the knobs so later suites that reuse this DB see defaults-ish state.
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantAId}/billing`,
      headers: bearer('padmin'),
      payload: {
        commissionBps: 0,
        consumerCommissionBps: 0,
        customerFeeShareBps: 10000,
        orgFeeShareBps: 0,
        advancePayoutBps: 0,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('active scope hides an archived draft; all shows it flagged', async () => {
    const evRows = await db.execute<{ id: string }>(sql`
      INSERT INTO events (tenant_id, name, starts_at, ends_at, status, address_json, tz_name, archived_at)
      VALUES (${tenantAId}::uuid, 'Shelved Draft', now() + interval '9 days',
              now() + interval '9 days 2 hours', 'draft', '{"city":"Nagpur"}'::jsonb,
              'Asia/Kolkata', now())
      RETURNING id
    `);
    const eventId = ((evRows as unknown as { id: string }[])[0]!).id;

    const listed = async (query: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/admin/tenants/${tenantAId}/events${query}`,
        headers: bearer('padmin'),
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { rows: Array<Record<string, unknown>> }).rows;
    };

    // A draft is an active status, so only the archive check keeps it out.
    expect((await listed('')).some((r) => r['id'] === eventId)).toBe(false);

    const all = await listed('?scope=all');
    const row = all.find((r) => r['id'] === eventId);
    expect(row).toBeDefined();
    expect(row!['archived']).toBe(true);

    // The partner-portal shelves: archived lists it, unarchived does not.
    expect((await listed('?scope=archived')).some((r) => r['id'] === eventId)).toBe(true);
    expect((await listed('?scope=unarchived')).some((r) => r['id'] === eventId)).toBe(false);

    await db.execute(sql`delete from events where id = ${eventId}::uuid`);
  });

  it('unarchived scope keeps an ended event that active drops', async () => {
    const evRows = await db.execute<{ id: string }>(sql`
      INSERT INTO events (tenant_id, name, starts_at, ends_at, status, address_json, tz_name)
      VALUES (${tenantAId}::uuid, 'Ended Meetup', now() - interval '9 days',
              now() - interval '9 days' + interval '2 hours', 'completed',
              '{"city":"Nagpur"}'::jsonb, 'Asia/Kolkata')
      RETURNING id
    `);
    const eventId = ((evRows as unknown as { id: string }[])[0]!).id;

    const listed = async (query: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/admin/tenants/${tenantAId}/events${query}`,
        headers: bearer('padmin'),
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { rows: Array<Record<string, unknown>> }).rows;
    };

    expect((await listed('?scope=active')).some((r) => r['id'] === eventId)).toBe(false);
    const row = (await listed('?scope=unarchived')).find((r) => r['id'] === eventId);
    expect(row).toBeDefined();
    expect(row!['archived']).toBe(false);
    expect(row!['venueId']).toBeNull();
    expect(row!['seriesId']).toBeNull();
    expect(row!['tzName']).toBe('Asia/Kolkata');
    // Over, so customers can't open it: no consumer-site link.
    expect(row!['url']).toBeNull();
    expect((await listed('?scope=archived')).some((r) => r['id'] === eventId)).toBe(false);

    const bad = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantAId}/events?scope=bogus`,
      headers: bearer('padmin'),
    });
    expect(bad.statusCode).toBe(400);

    await db.execute(sql`delete from events where id = ${eventId}::uuid`);
  });

  it('a live event links to its consumer page; one awaiting review does not', async () => {
    const evRows = await db.execute<{ id: string; status: string }>(sql`
      INSERT INTO events (tenant_id, name, starts_at, ends_at, status, address_json, tz_name)
      VALUES (${tenantAId}::uuid, 'Live Meetup', now() + interval '9 days',
              now() + interval '9 days 2 hours', 'published', '{"city":"Nagpur"}'::jsonb, 'Asia/Kolkata'),
             (${tenantAId}::uuid, 'Queued Meetup', now() + interval '9 days',
              now() + interval '9 days 2 hours', 'pending_review', '{"city":"Nagpur"}'::jsonb, 'Asia/Kolkata')
      RETURNING id, status
    `);
    const inserted = evRows as unknown as { id: string; status: string }[];
    const liveId = inserted.find((e) => e.status === 'published')!.id;
    const queuedId = inserted.find((e) => e.status === 'pending_review')!.id;
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/admin/tenants/${tenantAId}/events`,
        headers: bearer('padmin'),
      });
      expect(res.statusCode).toBe(200);
      const rows = (res.json() as { rows: Array<Record<string, unknown>> }).rows;
      expect(rows.find((r) => r['id'] === liveId)!['url']).toMatch(new RegExp(`/events/${liveId}$`));
      expect(rows.find((r) => r['id'] === queuedId)!['url']).toBeNull();
    } finally {
      await db.execute(sql`delete from events where id in (${liveId}::uuid, ${queuedId}::uuid)`);
    }
  });

  it('events GET needs only the read cap; editing overrides still needs billing', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantAId}/events`,
      headers: bearer('owner'),
    });
    expect(forbidden.statusCode).toBe(403);

    // Demote padmin to the read-only platform role for the duration: it has
    // admin.tenants.read but not admin.tenants.billing.
    await db.execute(sql`
      UPDATE tenant_members SET role = 'readonly'
       WHERE tenant_id = ${platformTenantId}::uuid AND user_id = ${adminUserId}::uuid
    `);
    try {
      const list = await app.inject({
        method: 'GET',
        url: `/v1/admin/tenants/${tenantAId}/events?scope=all`,
        headers: bearer('padmin'),
      });
      expect(list.statusCode).toBe(200);

      const patch = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/events/00000000-0000-0000-0000-000000000000/billing`,
        headers: bearer('padmin'),
        payload: { partnerCommissionBps: 100 },
      });
      expect(patch.statusCode).toBe(403);
    } finally {
      await db.execute(sql`
        UPDATE tenant_members SET role = 'manager'
         WHERE tenant_id = ${platformTenantId}::uuid AND user_id = ${adminUserId}::uuid
      `);
    }
  });

  it('venues — shelves split live/pending from closed/rejected; non-admin 403', async () => {
    const vRows = await db.execute<{ id: string; status: string }>(sql`
      INSERT INTO venues (tenant_id, name, status, city, state, tags)
      VALUES
        (${tenantAId}::uuid, 'Shelf Live',     'active',         'Nagpur', 'MH', '{indoor}'),
        (${tenantAId}::uuid, 'Shelf Pending',  'pending_review', NULL,     NULL, '{}'),
        (${tenantAId}::uuid, 'Shelf Closed',   'suspended',      NULL,     NULL, '{}'),
        (${tenantAId}::uuid, 'Shelf Rejected', 'rejected',       NULL,     NULL, '{}')
      RETURNING id, status
    `);
    const inserted = vRows as unknown as { id: string; status: string }[];
    const ids = new Set(inserted.map((v) => v.id));
    const byStatus = (s: string) => inserted.find((v) => v.status === s)!.id;

    const listed = async (query: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/admin/tenants/${tenantAId}/venues${query}`,
        headers: bearer('padmin'),
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as Array<Record<string, unknown>>).filter((r) => ids.has(r['id'] as string));
    };

    const active = await listed('');
    expect(active.map((r) => r['status']).sort()).toEqual(['active', 'pending_review']);
    const live = active.find((r) => r['id'] === byStatus('active'))!;
    expect(live['city']).toBe('Nagpur');
    expect(live['state']).toBe('MH');
    expect(live['tags']).toEqual(['indoor']);
    // Only the live venue is on the consumer site.
    expect(live['url']).toMatch(new RegExp(`/venues/${byStatus('active')}$`));
    expect(active.find((r) => r['id'] === byStatus('pending_review'))!['url']).toBeNull();

    const closed = await listed('?shelf=closed');
    expect(closed.map((r) => r['status']).sort()).toEqual(['rejected', 'suspended']);
    expect(closed.every((r) => r['url'] === null)).toBe(true);

    expect((await listed('?shelf=all')).length).toBe(4);

    const forbidden = await app.inject({
      method: 'GET',
      url: `/v1/admin/tenants/${tenantAId}/venues`,
      headers: bearer('owner'),
    });
    expect(forbidden.statusCode).toBe(403);

    await db.execute(sql`delete from venues where id in (${sql.join([...ids].map((id) => sql`${id}::uuid`), sql`, `)})`);
  });

  it('memberships — shelves, tier summary and currency', async () => {
    const mRows = await db.execute<{ id: string; status: string }>(sql`
      INSERT INTO memberships (tenant_id, name, duration_days, price_paise, status)
      VALUES
        (${tenantAId}::uuid, 'Tiered Plan',  30, 0,     'active'),
        (${tenantAId}::uuid, 'Legacy Plan',  30, 70000, 'pending_review'),
        (${tenantAId}::uuid, 'Off Plan',     30, 0,     'inactive'),
        (${tenantAId}::uuid, 'Bounced Plan', 30, 0,     'rejected')
      RETURNING id, status
    `);
    const inserted = mRows as unknown as { id: string; status: string }[];
    const ids = new Set(inserted.map((m) => m.id));
    const tieredId = inserted.find((m) => m.status === 'active')!.id;
    const legacyId = inserted.find((m) => m.status === 'pending_review')!.id;
    await db.execute(sql`
      INSERT INTO membership_tiers (membership_id, tenant_id, name, duration_days, price_paise, deleted_at)
      VALUES
        (${tieredId}::uuid, ${tenantAId}::uuid, 'Monthly', 30,  50000,  NULL),
        (${tieredId}::uuid, ${tenantAId}::uuid, 'Yearly',  365, 200000, NULL),
        (${tieredId}::uuid, ${tenantAId}::uuid, 'Gone',    30,  1,      now())
    `);

    const listed = async (query: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/admin/tenants/${tenantAId}/memberships${query}`,
        headers: bearer('padmin'),
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as Array<Record<string, unknown>>).filter((r) => ids.has(r['id'] as string));
    };

    const active = await listed('');
    expect(active.map((r) => r['status']).sort()).toEqual(['active', 'pending_review']);

    // Deleted tiers are left out of the count and the range.
    const tiered = active.find((r) => r['id'] === tieredId)!;
    expect(tiered['tierCount']).toBe(2);
    expect(tiered['minPricePaise']).toBe(50000);
    expect(tiered['maxPricePaise']).toBe(200000);
    expect(tiered['venueId']).toBeNull();
    // Tenant A was created with country 'India'.
    expect(tiered['currency']).toBe('INR');
    // Live, so it links to its consumer page; the one awaiting review does not.
    expect(tiered['url']).toMatch(new RegExp(`/memberships/${tieredId}$`));
    expect(active.find((r) => r['id'] === legacyId)!['url']).toBeNull();

    // No tiers: the plan's own legacy price stands in.
    const legacy = active.find((r) => r['id'] === legacyId)!;
    expect(legacy['tierCount']).toBe(0);
    expect(legacy['minPricePaise']).toBe(70000);
    expect(legacy['maxPricePaise']).toBe(70000);

    const inactive = await listed('?shelf=inactive');
    expect(inactive.map((r) => r['status']).sort()).toEqual(['inactive', 'rejected']);
    expect((await listed('?shelf=all')).length).toBe(4);

    await db.execute(sql`delete from memberships where id in (${sql.join([...ids].map((id) => sql`${id}::uuid`), sql`, `)})`);
  });
});
