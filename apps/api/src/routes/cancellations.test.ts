import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_cxowner', email: 'cxowner@x.com', email_verified: true },
      customer: { uid: 'fbuid_cxcustomer', email: 'cxcustomer@x.com', email_verified: true },
      stranger: { uid: 'fbuid_cxstranger', email: 'cxstranger@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { bookings, payments } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');
const { issueRefund } = await import('../services/refund_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface Preview {
  bookingId: string;
  tier: string;
  refundPaise: number;
  amountPaise: number;
  alreadyRefundedPaise: number;
}

describe.skipIf(!runIntegration)('refund preview and cancel', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let customerUserId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Refund Co', slug: `cxco-${Date.now()}`, country: 'India', acceptTerms: true },
    });
    tenantId = t.json().id;

    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Refund Venue' },
    });
    venueId = v.json().id;

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('customer') });
    expect(me.statusCode).toBe(200);
    customerUserId = (me.json() as { id: string }).id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  /**
   * A consumer's online booking starting `hoursAhead` from now, with a ₹500
   * charge in `chargeStatus` (null → no charge row at all). No arena, so the
   * bookings' overlap constraint never bites across tests.
   */
  async function seedOnlineBooking(
    hoursAhead: number,
    chargeStatus: 'captured' | 'pending' | null = 'captured',
  ): Promise<string> {
    const start = new Date(Date.now() + hoursAhead * 3_600_000);
    const end = new Date(start.getTime() + 3_600_000);
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: chargeStatus === 'captured' ? 'confirmed' : 'pending',
        customerName: 'Refund Test',
        customerContact: '+91-9000000456',
        customerUserId,
        totalPaise: 50000,
        timeRange: `[${start.toISOString()},${end.toISOString()})`,
      })
      .returning();
    if (chargeStatus) {
      await db.insert(payments).values({
        bookingId: b!.id,
        tenantId,
        provider: 'stub',
        amountPaise: 50000,
        status: chargeStatus,
        kind: 'charge',
      });
    }
    return b!.id;
  }

  async function preview(bookingId: string, token: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/bookings/${bookingId}/refund-preview`,
      headers: bearer(token),
    });
  }

  async function cancel(bookingId: string, token: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/bookings/${bookingId}/cancel`,
      headers: bearer(token),
      payload: { reason: 'refund test' },
    });
  }

  async function refundRows(bookingId: string) {
    return db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingId} and kind = 'refund'`);
  }

  it('previews a staff refund as a full override, however close the start', async () => {
    const bookingId = await seedOnlineBooking(1);
    const res = await preview(bookingId, 'owner');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      bookingId,
      tier: 'override',
      refundPaise: 50000,
      amountPaise: 50000,
      alreadyRefundedPaise: 0,
    });
  });

  it("previews the timing tiers for the booking's own customer", async () => {
    const bookingId = await seedOnlineBooking(12);
    const own = (await preview(bookingId, 'customer')).json() as Preview;
    expect(own).toMatchObject({ tier: 'partial', refundPaise: 25000 });
    // Same booking, staff caller → the override.
    const staff = (await preview(bookingId, 'owner')).json() as Preview;
    expect(staff).toMatchObject({ tier: 'override', refundPaise: 50000 });
  });

  it('refuses a caller who is neither the customer nor a tenant member', async () => {
    const bookingId = await seedOnlineBooking(12);
    const res = await preview(bookingId, 'stranger');
    expect(res.statusCode).toBe(403);
  });

  it('refunds exactly what the preview showed', async () => {
    const bookingId = await seedOnlineBooking(1);
    const shown = (await preview(bookingId, 'owner')).json() as Preview;

    const res = await cancel(bookingId, 'owner');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ policy: shown.tier, refundPaise: shown.refundPaise });
    expect(await refundRows(bookingId)).toHaveLength(1);

    // Cancelled now, so there is nothing left to preview.
    expect((await preview(bookingId, 'owner')).statusCode).toBe(409);
  });

  it('after a partial refund, previews and refunds only the rest', async () => {
    const bookingId = await seedOnlineBooking(1);
    await issueRefund({ bookingId, amountPaise: 20000, reason: 'goodwill', actorUserId: null });

    const shown = (await preview(bookingId, 'owner')).json() as Preview;
    expect(shown).toMatchObject({ tier: 'override', refundPaise: 30000, alreadyRefundedPaise: 20000 });

    // Used to 409 (refund_exceeds_charge) and roll the whole cancel back.
    const res = await cancel(bookingId, 'owner');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ policy: 'override', refundPaise: 30000 });
    const [charge] = await db
      .select()
      .from(payments)
      .where(sql`booking_id = ${bookingId} and kind = 'charge'`);
    expect(charge?.status).toBe('refunded');
  });

  it('cancels a booking already refunded in full without refunding again', async () => {
    const bookingId = await seedOnlineBooking(1);
    await issueRefund({ bookingId, amountPaise: 50000, reason: 'goodwill', actorUserId: null });

    const shown = (await preview(bookingId, 'owner')).json() as Preview;
    expect(shown).toMatchObject({ tier: 'already_refunded', refundPaise: 0 });

    const res = await cancel(bookingId, 'owner');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'cancelled', policy: 'already_refunded', refundPaise: 0 });
    expect(await refundRows(bookingId)).toHaveLength(1);
  });

  it('reports no refund for an online booking whose charge row never landed', async () => {
    const bookingId = await seedOnlineBooking(1, null);

    const shown = (await preview(bookingId, 'owner')).json() as Preview;
    expect(shown).toMatchObject({ tier: 'uncaptured', refundPaise: 0 });

    // Used to report the booking total as refunded although no refund ran.
    const res = await cancel(bookingId, 'owner');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ policy: 'uncaptured', refundPaise: 0 });
    expect(res.json().refundId).toBeUndefined();
    expect(await refundRows(bookingId)).toHaveLength(0);
  });

  it('previews a never-completed payment as nothing to refund', async () => {
    const bookingId = await seedOnlineBooking(1, 'pending');
    const shown = (await preview(bookingId, 'owner')).json() as Preview;
    expect(shown).toMatchObject({ tier: 'uncaptured', refundPaise: 0 });
  });
});
