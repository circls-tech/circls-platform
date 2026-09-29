/**
 * Consumer payment routes: a customer can check and switch only their own
 * checkout's payment. Service behaviour is covered in
 * payment_recovery_service.test.ts; this pins the HTTP surface and ownership.
 *
 * Integration-gated (RUN_INTEGRATION) like the other route tests.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      buyer: { uid: 'fbuid_cp_buyer', phone_number: '+919800000101' },
      other: { uid: 'fbuid_cp_other', phone_number: '+919800000102' },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { bookings, payments, tenants } = await import('../db/schema/index.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('consumer payment routes', () => {
  let app: FastifyInstance;
  const SUFFIX = Date.now();
  let tenantId: string;
  const orderId = `cf-route-${SUFFIX}`;
  const userIds: Record<string, string> = {};

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    for (const who of ['buyer', 'other']) {
      const res = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer(who) });
      expect(res.statusCode).toBe(200);
      userIds[who] = (res.json() as { profile: { id: string } }).profile.id;
    }
    const [t] = await db.insert(tenants).values({ name: 'Pay Route Co', slug: `payroute-${SUFFIX}` }).returning();
    tenantId = t!.id;
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'pending',
        totalPaise: 20000,
        customerUserId: userIds['buyer']!,
        createdByUserId: userIds['buyer']!,
      })
      .returning();
    await db.insert(payments).values({
      bookingId: b!.id,
      tenantId,
      provider: 'cashfree',
      providerOrderId: orderId,
      amountPaise: 20000,
      currency: 'INR',
      status: 'pending',
      kind: 'charge',
    });
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await app.close();
    await closeDb();
  });

  it('the buyer sees their checkout pending', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/consumer/payments/${orderId}/status`,
      headers: bearer('buyer'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'pending' });
  });

  it('anyone else gets a 404, for reads and switches alike', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/v1/consumer/payments/${orderId}/status`,
      headers: bearer('other'),
    });
    expect(read.statusCode).toBe(404);
    const sw = await app.inject({
      method: 'POST',
      url: `/v1/consumer/payments/${orderId}/switch-gateway`,
      headers: bearer('other'),
    });
    expect(sw.statusCode).toBe(404);
  });

  it('signed-out callers are refused', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/consumer/payments/${orderId}/status` });
    expect(res.statusCode).toBe(401);
  });

  it('the buyer can switch to Razorpay', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/payments/${orderId}/switch-gateway`,
      headers: bearer('buyer'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      outcome: 'switched',
      payment: { gateway: 'razorpay', amountPaise: 20000, currency: 'INR' },
    });
  });
});
