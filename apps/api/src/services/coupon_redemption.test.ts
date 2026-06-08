import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_redeem_owner', email: 'redeemowner@x.com', email_verified: true },
      consumer: { uid: 'fbuid_redeem_consumer', email: 'redeemconsumer@x.com', email_verified: true },
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

/** Insert a coupon directly so we can mint platform-owned coupons (no admin route token here). */
async function seedCoupon(opts: {
  code: string;
  ownerType: 'platform' | 'tenant';
  tenantId: string | null;
  discountValue: number; // bps for percent
  maxRedemptions?: number | null;
}): Promise<void> {
  await db.execute(sql`
    insert into coupons (owner_type, tenant_id, code, scope_type, discount_type, discount_value, visibility, status, max_redemptions)
    values (
      ${opts.ownerType},
      ${opts.tenantId}::uuid,
      ${opts.code},
      'org',
      'percent',
      ${opts.discountValue},
      'private',
      'active',
      ${opts.maxRedemptions ?? null}
    )
  `);
}

describe.skipIf(!runIntegration)('coupon redemption in event booking', () => {
  let app: FastifyInstance;
  let ownerId: string;
  let tenantId: string;
  let eventId: string;
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
      payload: { name: 'RedeemRoutes', slug: `redeemroutes-${SUFFIX}` },
    });
    tenantId = (t.json() as { id: string }).id;

    const ev = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: { line1: '1 Test St', city: 'Mumbai' },
        tzName: 'Asia/Kolkata',
        name: 'Redeem Test Event',
        startsAt: '2030-09-01T10:00:00.000Z',
        endsAt: '2030-09-01T12:00:00.000Z',
        pricePaise: 50000,
      },
    });
    eventId = (ev.json() as { id: string }).id;
    await db.execute(sql`update events set status='published' where id = ${eventId}`);
  });

  afterAll(async () => {
    await db.execute(sql`delete from coupon_redemptions where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from payments where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from coupons where tenant_id = ${tenantId} or owner_type = 'platform' and code like ${'%' + String(SUFFIX)}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where firebase_uid = 'fbuid_redeem_consumer'`);
    await db.execute(sql`delete from users where id = ${ownerId}`);
    await app.close();
    await closeDb();
  });

  it('platform coupon (10%): records redemption funder=platform, payment settle_base=50000, amount=46088', async () => {
    const code = `PLAT10-${SUFFIX}`;
    await seedCoupon({ code, ownerType: 'platform', tenantId: null, discountValue: 1000 });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${eventId}/book`,
      headers: bearer('consumer'),
      payload: { couponCode: code },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { booking: { id: string }; amountPaise: number };
    const bookingId = body.booking.id;
    expect(body.amountPaise).toBe(46088);

    const redRows = (await db.execute(sql`
      select discount_paise, funder, base_paise from coupon_redemptions where booking_id = ${bookingId}::uuid
    `)) as unknown as Record<string, unknown>[];
    expect(redRows.length).toBe(1);
    expect(Number(redRows[0]!['discount_paise'])).toBe(5000);
    expect(redRows[0]!['funder']).toBe('platform');
    expect(Number(redRows[0]!['base_paise'])).toBe(50000);

    const payRows = (await db.execute(sql`
      select settle_base_paise, amount_paise from payments where booking_id = ${bookingId}::uuid
    `)) as unknown as Record<string, unknown>[];
    expect(payRows.length).toBe(1);
    expect(Number(payRows[0]!['settle_base_paise'])).toBe(50000);
    expect(Number(payRows[0]!['amount_paise'])).toBe(46088);
  });

  it('org coupon (10%): settle_base=45000 (discounted base), funder=org', async () => {
    const code = `ORG10-${SUFFIX}`;
    await seedCoupon({ code, ownerType: 'tenant', tenantId, discountValue: 1000 });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${eventId}/book`,
      headers: bearer('consumer'),
      payload: { couponCode: code },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { booking: { id: string }; amountPaise: number };
    const bookingId = body.booking.id;
    expect(body.amountPaise).toBe(46088);

    const redRows = (await db.execute(sql`
      select funder from coupon_redemptions where booking_id = ${bookingId}::uuid
    `)) as unknown as Record<string, unknown>[];
    expect(redRows[0]!['funder']).toBe('org');

    const payRows = (await db.execute(sql`
      select settle_base_paise from payments where booking_id = ${bookingId}::uuid
    `)) as unknown as Record<string, unknown>[];
    expect(Number(payRows[0]!['settle_base_paise'])).toBe(45000);
  });

  it('maxRedemptions=1: second redemption → 409 coupon_max_redeemed', async () => {
    const code = `CAP1-${SUFFIX}`;
    await seedCoupon({ code, ownerType: 'tenant', tenantId, discountValue: 1000, maxRedemptions: 1 });

    const first = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${eventId}/book`,
      headers: bearer('consumer'),
      payload: { couponCode: code },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/consumer/events/${eventId}/book`,
      headers: bearer('consumer'),
      payload: { couponCode: code },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { code: string }).code).toBe('coupon_max_redeemed');
  });
});
