import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      padmin: { uid: 'fbuid_cstats_padmin', email: 'cstats_padmin@x.com', email_verified: true },
      owner: { uid: 'fbuid_cstats_owner', email: 'cstats_owner@x.com', email_verified: true },
      ownerB: { uid: 'fbuid_cstats_ownerb', email: 'cstats_ownerb@x.com', email_verified: true },
      outsider: { uid: 'fbuid_cstats_out', email: 'cstats_out@x.com', email_verified: true },
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

interface FunderTotals {
  redemptions: number;
  discountPaise: number;
  basePaise: number;
}
interface StatRow {
  couponId: string;
  code: string;
  redemptions: number;
  discountPaise: number;
  basePaise: number;
}
interface TenantStats {
  orgFunded: FunderTotals;
  platformFunded: FunderTotals;
  byCoupon: StatRow[];
}
interface AdminStats extends TenantStats {
  monthly: { month: string; redemptions: number; discountPaise: number }[];
}

async function seedCoupon(opts: {
  code: string;
  ownerType: 'platform' | 'tenant';
  tenantId: string | null;
}): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into coupons (owner_type, tenant_id, code, scope_type, discount_type, discount_value, visibility, status)
    values (${opts.ownerType}, ${opts.tenantId}::uuid, ${opts.code}, 'org', 'percent', 1000, 'private', 'active')
    returning id
  `);
  return (rows as unknown as { id: string }[])[0]!.id;
}

/** Minimal confirmed booking so redemptions satisfy their NOT NULL booking FK. */
async function seedRedemption(opts: {
  couponId: string;
  tenantId: string;
  basePaise: number;
  discountPaise: number;
  funder: 'org' | 'platform';
  createdAt: string; // ISO — fixed 2018/2019 dates keep admin totals isolated from concurrent suites
}): Promise<void> {
  const bookingRows = await db.execute<{ id: string }>(sql`
    insert into bookings (tenant_id, item_type, channel, payment_method, status, currency)
    values (${opts.tenantId}::uuid, 'event', 'circls', 'free', 'confirmed', 'INR')
    returning id
  `);
  const bookingId = (bookingRows as unknown as { id: string }[])[0]!.id;
  await db.execute(sql`
    insert into coupon_redemptions (coupon_id, booking_id, tenant_id, base_paise, discount_paise, funder, created_at)
    values (${opts.couponId}::uuid, ${bookingId}::uuid, ${opts.tenantId}::uuid,
            ${opts.basePaise}, ${opts.discountPaise}, ${opts.funder}, ${opts.createdAt}::timestamptz)
  `);
}

describe.skipIf(!runIntegration)('coupon funding stats routes', () => {
  let app: FastifyInstance;
  let adminUserId: string;
  let ownerIds: string[] = [];
  let tenantAId: string;
  let tenantBId: string;
  let tenantCId: string; // no redemptions — zero-state
  let platformTenantId: string;
  let couponA1: string;
  let couponA2: string;
  let couponPlat: string;
  const SUFFIX = Date.now();
  const PLATFORM_SLUG = `circls-internal-test-cstats-${SUFFIX}`;
  let prevSlug: string | undefined;

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    for (const token of ['padmin', 'owner', 'ownerB', 'outsider']) {
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
      expect(me.statusCode).toBe(200);
      const id = (me.json() as { id: string }).id;
      if (token === 'padmin') adminUserId = id;
      ownerIds.push(id);
    }

    const ptRows = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = (ptRows as unknown as { id: string }[])[0]!.id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${adminUserId}::uuid, 'manager')
    `);

    async function createTenant(token: string, slug: string): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tenants',
        headers: bearer(token),
        payload: { name: `CStats ${slug}`, slug, country: 'India', acceptTerms: true },
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { id: string }).id;
    }
    tenantAId = await createTenant('owner', `cstats-a-${SUFFIX}`);
    tenantBId = await createTenant('ownerB', `cstats-b-${SUFFIX}`);
    tenantCId = await createTenant('owner', `cstats-c-${SUFFIX}`);

    couponA1 = await seedCoupon({ code: `CSA1-${SUFFIX}`, ownerType: 'tenant', tenantId: tenantAId });
    couponA2 = await seedCoupon({ code: `CSA2-${SUFFIX}`, ownerType: 'tenant', tenantId: tenantAId });
    couponPlat = await seedCoupon({ code: `CSPLAT-${SUFFIX}`, ownerType: 'platform', tenantId: null });

    // Tenant A: three org-funded (one outside the 2019 window) + one platform-funded.
    await seedRedemption({ couponId: couponA1, tenantId: tenantAId, basePaise: 10000, discountPaise: 1000, funder: 'org', createdAt: '2018-01-01T10:00:00Z' });
    await seedRedemption({ couponId: couponA1, tenantId: tenantAId, basePaise: 50000, discountPaise: 5000, funder: 'org', createdAt: '2019-03-10T10:00:00Z' });
    await seedRedemption({ couponId: couponA1, tenantId: tenantAId, basePaise: 70000, discountPaise: 7000, funder: 'org', createdAt: '2019-03-20T10:00:00Z' });
    await seedRedemption({ couponId: couponA2, tenantId: tenantAId, basePaise: 20000, discountPaise: 2000, funder: 'org', createdAt: '2019-04-05T10:00:00Z' });
    await seedRedemption({ couponId: couponPlat, tenantId: tenantAId, basePaise: 30000, discountPaise: 3000, funder: 'platform', createdAt: '2019-03-15T10:00:00Z' });
    // Tenant B: one platform-funded.
    await seedRedemption({ couponId: couponPlat, tenantId: tenantBId, basePaise: 40000, discountPaise: 4000, funder: 'platform', createdAt: '2019-04-10T10:00:00Z' });
  });

  afterAll(async () => {
    for (const tid of [tenantAId, tenantBId, tenantCId]) {
      await db.execute(sql`delete from coupon_redemptions where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from bookings where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from coupons where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from audit_log where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from tenant_members where tenant_id = ${tid}::uuid`);
      await db.execute(sql`delete from tenants where id = ${tid}::uuid`);
    }
    await db.execute(sql`delete from coupons where id = ${couponPlat}::uuid`);
    if (platformTenantId) {
      await db.execute(sql`DELETE FROM tenant_members WHERE tenant_id = ${platformTenantId}::uuid`);
      await db.execute(sql`DELETE FROM tenants WHERE id = ${platformTenantId}::uuid`);
    }
    for (const uid of ownerIds) {
      await db.execute(sql`delete from users where id = ${uid}::uuid`);
    }
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug ?? 'circls-internal';
    __resetPlatformTenantCacheForTesting();
    await app.close();
    await closeDb();
  });

  it('tenant stats: totals split by funder, byCoupon org-only ordered by discount desc', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantAId}/coupons/stats`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json() as TenantStats;
    expect(stats.orgFunded).toEqual({ redemptions: 4, discountPaise: 15000, basePaise: 150000 });
    expect(stats.platformFunded).toEqual({ redemptions: 1, discountPaise: 3000, basePaise: 30000 });
    expect(stats.byCoupon).toHaveLength(2);
    expect(stats.byCoupon[0]).toEqual({
      couponId: couponA1,
      code: `CSA1-${SUFFIX}`,
      redemptions: 3,
      discountPaise: 13000,
      basePaise: 130000,
    });
    expect(stats.byCoupon[1]!.couponId).toBe(couponA2);
    expect(stats.byCoupon[1]!.discountPaise).toBe(2000);
  });

  it('tenant stats: from/to filters redemptions by created_at', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantAId}/coupons/stats?from=${encodeURIComponent('2019-01-01T00:00:00Z')}`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json() as TenantStats;
    expect(stats.orgFunded).toEqual({ redemptions: 3, discountPaise: 14000, basePaise: 140000 });
    expect(stats.byCoupon[0]!.discountPaise).toBe(12000);
  });

  it('tenant stats: invalid datetime → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantAId}/coupons/stats?from=notadate`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('tenant isolation: tenant B sees only its own redemptions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantBId}/coupons/stats`,
      headers: bearer('ownerB'),
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json() as TenantStats;
    expect(stats.orgFunded).toEqual({ redemptions: 0, discountPaise: 0, basePaise: 0 });
    expect(stats.platformFunded).toEqual({ redemptions: 1, discountPaise: 4000, basePaise: 40000 });
    expect(stats.byCoupon).toEqual([]);
  });

  it('zero-state: tenant with no redemptions gets zeros and empty arrays', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantCId}/coupons/stats`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json() as TenantStats;
    expect(stats.orgFunded).toEqual({ redemptions: 0, discountPaise: 0, basePaise: 0 });
    expect(stats.platformFunded).toEqual({ redemptions: 0, discountPaise: 0, basePaise: 0 });
    expect(stats.byCoupon).toEqual([]);
  });

  it('authz: non-member → 403, unauthenticated → 401', async () => {
    const nonMember = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantAId}/coupons/stats`,
      headers: bearer('outsider'),
    });
    expect(nonMember.statusCode).toBe(403);

    const anon = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantAId}/coupons/stats`,
    });
    expect(anon.statusCode).toBe(401);
  });

  it('admin stats: funder totals, platform-only byCoupon, IST monthly buckets', async () => {
    // Bound to the seeded 2019 window so concurrent suites' now()-stamped
    // redemptions can't leak into the platform-wide aggregates.
    const qs = `from=${encodeURIComponent('2019-01-01T00:00:00Z')}&to=${encodeURIComponent('2019-05-01T00:00:00Z')}`;
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/coupons/stats?${qs}`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json() as AdminStats;
    expect(stats.platformFunded).toEqual({ redemptions: 2, discountPaise: 7000, basePaise: 70000 });
    expect(stats.orgFunded).toEqual({ redemptions: 3, discountPaise: 14000, basePaise: 140000 });
    expect(stats.byCoupon).toEqual([
      {
        couponId: couponPlat,
        code: `CSPLAT-${SUFFIX}`,
        redemptions: 2,
        discountPaise: 7000,
        basePaise: 70000,
      },
    ]);
    expect(stats.monthly).toEqual([
      { month: '2019-03', redemptions: 1, discountPaise: 3000 },
      { month: '2019-04', redemptions: 1, discountPaise: 4000 },
    ]);
  });

  it('admin stats: non-platform member → 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/coupons/stats',
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(403);
  });
});
