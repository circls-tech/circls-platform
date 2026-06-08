import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_chk_owner', email: 'chkowner@x.com', email_verified: true },
      consumer: { uid: 'fbuid_chk_consumer', email: 'chkconsumer@x.com', email_verified: true },
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

describe.skipIf(!runIntegration)('checkout quote + public coupons endpoints', () => {
  let app: FastifyInstance;
  let ownerId: string;
  let tenantId: string;
  let eventId: string;
  let couponCode: string;
  const SUFFIX = Date.now();

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // Bootstrap owner + tenant
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    ownerId = (me.json() as { id: string }).id;
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'ChkRoutes', slug: `chkroutes-${SUFFIX}` },
    });
    tenantId = (t.json() as { id: string }).id;

    // Create a published event with pricePaise=50000
    const ev = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: { line1: '1 Test St', city: 'Mumbai' },
        tzName: 'Asia/Kolkata',
        name: 'Checkout Test Event',
        startsAt: '2030-09-01T10:00:00.000Z',
        endsAt: '2030-09-01T12:00:00.000Z',
        pricePaise: 50000,
      },
    });
    eventId = (ev.json() as { id: string }).id;
    // Publish the event directly via DB (mirrors plan pattern)
    await db.execute(sql`update events set status='published' where id = ${eventId}`);
  });

  afterAll(async () => {
    await db.execute(sql`delete from coupon_redemptions where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from coupons where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    // Clean up auto-created consumer user
    await db.execute(sql`delete from users where firebase_uid = 'fbuid_chk_consumer'`);
    await db.execute(sql`delete from users where id = ${ownerId}`);
    await app.close();
    await closeDb();
  });

  it('quote with no coupon → basePaise 50000, totalPaise 51209, discountPaise 0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/checkout/quote',
      headers: bearer('consumer'),
      payload: { itemType: 'event', eventId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.basePaise).toBe(50000);
    expect(body.discountPaise).toBe(0);
    expect(body.totalPaise).toBe(51209);
    expect(body.coupon).toBeNull();
  });

  it('quote with a 10% public coupon → discountPaise 5000, totalPaise 46088, coupon.code matches', async () => {
    couponCode = `SAVE10-${SUFFIX}`;
    // Create a public org coupon (10% = 1000 bps)
    const cpn = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/coupons`,
      headers: bearer('owner'),
      payload: {
        code: couponCode,
        scopeType: 'org',
        discountType: 'percent',
        discountValue: 1000,
        visibility: 'public',
      },
    });
    expect(cpn.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/checkout/quote',
      headers: bearer('consumer'),
      payload: { itemType: 'event', eventId, couponCode },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.discountPaise).toBe(5000);
    expect(body.totalPaise).toBe(46088);
    expect(body.coupon).not.toBeNull();
    expect(body.coupon.code).toBe(couponCode);
  });

  it('quote with unknown code → error: coupon_not_found, totalPaise 51209', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/checkout/quote',
      headers: bearer('consumer'),
      payload: { itemType: 'event', eventId, couponCode: 'DOESNOTEXIST' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBe('coupon_not_found');
    expect(body.totalPaise).toBe(51209);
  });
});
