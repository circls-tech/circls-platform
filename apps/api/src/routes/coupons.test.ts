import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_cpn_owner', email: 'cpnowner@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('coupon CRUD routes', () => {
  let app: FastifyInstance;
  let ownerId: string;
  let tenantId: string;
  const SUFFIX = Date.now();

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    ownerId = (me.json() as { id: string }).id;
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'CpnRoutes', slug: `cpnroutes-${SUFFIX}` },
    });
    tenantId = (t.json() as { id: string }).id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from coupon_redemptions where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from coupons where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${ownerId}`);
    await app.close();
    await closeDb();
  });

  it('creates an org coupon (POST) then lists it (GET) → length 1', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/coupons`,
      headers: bearer('owner'),
      payload: {
        code: `SUMMER-${SUFFIX}`,
        scopeType: 'org',
        discountType: 'percent',
        discountValue: 1000,
      },
    });
    expect(res.statusCode).toBe(200);
    const coupon = res.json();
    expect(coupon.code).toBe(`SUMMER-${SUFFIX}`);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/coupons`,
      headers: bearer('owner'),
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it('rejects a non-org scope without scopeId → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/coupons`,
      headers: bearer('owner'),
      payload: {
        code: `VENUE-${SUFFIX}`,
        scopeType: 'venue',
        // scopeId intentionally omitted
        discountType: 'fixed',
        discountValue: 5000,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a duplicate code for the same tenant → 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/coupons`,
      headers: bearer('owner'),
      payload: {
        code: `SUMMER-${SUFFIX}`,
        scopeType: 'org',
        discountType: 'percent',
        discountValue: 500,
      },
    });
    expect(res.statusCode).toBe(409);
  });
});
