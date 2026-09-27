import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_plowner', email: 'plowner@x.com', email_verified: true },
      readonly: { uid: 'fbuid_plreadonly', email: 'plreadonly@x.com', email_verified: true },
      rival: { uid: 'fbuid_plrival', email: 'plrival@x.com', email_verified: true },
      customer: { uid: 'fbuid_plcustomer', email: 'plcustomer@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { bookings, payments, tenantMembers } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)("a booking's payments ledger", () => {
  let app: FastifyInstance;
  let bookingId: string;
  let chargeId: string;

  async function createTenant(token: string, name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer(token),
      payload: { name, slug: `pl-${token}-${Date.now()}`, country: 'India', acceptTerms: true },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { id: string }).id;
  }

  async function userId(token: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    return (res.json() as { id: string }).id;
  }

  function ledger(id: string, token: string) {
    return app.inject({ method: 'GET', url: `/v1/bookings/${id}/payments`, headers: bearer(token) });
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const tenantId = await createTenant('owner', 'Ledger Co');
    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Ledger Venue' },
    });
    const venueId = (v.json() as { id: string }).id;

    // A Read-only member of the tenant, and the owner of an unrelated one.
    await db.insert(tenantMembers).values({ userId: await userId('readonly'), tenantId, role: 'readonly' });
    await createTenant('rival', 'Rival Co');

    // A consumer's online booking with a captured charge.
    const start = new Date(Date.now() + 48 * 3_600_000);
    const end = new Date(start.getTime() + 3_600_000);
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        customerName: 'Ledger Test',
        customerContact: '+91-9000000458',
        customerUserId: await userId('customer'),
        totalPaise: 50000,
        timeRange: `[${start.toISOString()},${end.toISOString()})`,
      })
      .returning();
    bookingId = b!.id;
    const [charge] = await db
      .insert(payments)
      .values({
        bookingId,
        tenantId,
        provider: 'stub',
        amountPaise: 50000,
        status: 'captured',
        kind: 'charge',
      })
      .returning();
    chargeId = charge!.id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it("lists the ledger for a member of the booking's tenant, whatever their role", async () => {
    for (const token of ['owner', 'readonly']) {
      const res = await ledger(bookingId, token);
      expect(res.statusCode).toBe(200);
      const rows = res.json() as { id: string }[];
      expect(rows.map((r) => r.id)).toEqual([chargeId]);
    }
  });

  it('refuses a member of another tenant', async () => {
    const res = await ledger(bookingId, 'rival');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('tenant_forbidden');
  });

  it("refuses the booking's own customer, who is no member of the tenant", async () => {
    const res = await ledger(bookingId, 'customer');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('tenant_forbidden');
  });

  it('404s a booking that does not exist', async () => {
    const res = await ledger(crypto.randomUUID(), 'rival');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('booking_not_found');
  });
});
