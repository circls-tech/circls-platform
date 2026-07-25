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
  let tierId: string;
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
      payload: { name: 'ChkRoutes', slug: `chkroutes-${SUFFIX}`, country: 'India', acceptTerms: true },
    });
    tenantId = (t.json() as { id: string }).id;

    // Create a published event with a single General tier at 50000 paise
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
        tiers: [{ name: 'General', pricePaise: 50000 }],
      },
    });
    eventId = (ev.json() as { id: string }).id;

    // Read tier id back from DB (same pattern as multi-tier block)
    const tierRows = (await db.execute(sql`
      select id from event_ticket_tiers where event_id = ${eventId} and deleted_at is null
    `)) as unknown as Array<{ id: string }>;
    tierId = tierRows[0]!.id;

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
    // Note: closeDb() is called by the slot-cart coupons suite's afterAll (the
    // last describe in this file) so the shared pool stays open across suites.
  });

  it('quote with no coupon → basePaise 50000, totalPaise 51209, discountPaise 0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/checkout/quote',
      headers: bearer('consumer'),
      payload: { itemType: 'event', eventId, lines: [{ tierId, quantity: 1 }] },
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
      payload: { itemType: 'event', eventId, couponCode, lines: [{ tierId, quantity: 1 }] },
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
      payload: { itemType: 'event', eventId, couponCode: 'DOESNOTEXIST', lines: [{ tierId, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBe('coupon_not_found');
    expect(body.totalPaise).toBe(51209);
  });
});

describe.skipIf(!runIntegration)('checkout quote with multi-tier event lines', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let eventId: string;
  let vipTierId: string;
  let gaTierId: string;
  const SUFFIX = Date.now() + 1;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // Bootstrap owner + tenant
    await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'TierQuoteCo', slug: `tierquote-${SUFFIX}`, country: 'India', acceptTerms: true },
    });
    tenantId = (t.json() as { id: string }).id;

    // Create event with two tiers: VIP (50000) + GA (20000)
    const ev = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: { line1: '1 Test St', city: 'Mumbai' },
        tzName: 'Asia/Kolkata',
        name: 'Tier Quote Event',
        startsAt: '2030-10-01T10:00:00.000Z',
        endsAt: '2030-10-01T12:00:00.000Z',
        tiers: [
          { name: 'VIP', pricePaise: 50000 },
          { name: 'GA', pricePaise: 20000 },
        ],
      },
    });
    expect(ev.statusCode).toBe(200);
    eventId = (ev.json() as { id: string }).id;

    // Read tier ids back by name (same pattern as bookings.test.ts)
    const tierRows = (await db.execute(sql`
      select id, name from event_ticket_tiers where event_id = ${eventId} and deleted_at is null
    `)) as unknown as Array<{ id: string; name: string }>;
    vipTierId = tierRows.find((x) => x.name === 'VIP')!.id;
    gaTierId = tierRows.find((x) => x.name === 'GA')!.id;

    // Publish directly via DB (same as existing checkout test + bookings.test.ts)
    await db.execute(sql`update events set status='published' where id = ${eventId}`);
  });

  afterAll(async () => {
    await db.execute(sql`delete from event_ticket_tiers where event_id = ${eventId}`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    // Clean up auto-created consumer user (same as first describe block)
    await db.execute(sql`delete from users where firebase_uid = 'fbuid_chk_consumer'`);
    await app.close();
    // closeDb() moved to the slot-cart coupons suite (now the last describe).
  });

  it('quote with lines → basePaise = 2×VIP + 1×GA = 120000', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/consumer/checkout/quote',
      headers: bearer('consumer'),
      payload: {
        itemType: 'event',
        eventId,
        lines: [
          { tierId: vipTierId, quantity: 2 },
          { tierId: gaTierId, quantity: 1 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.basePaise).toBe(120000); // 2*50000 + 1*20000
    expect(body.coupon).toBeNull();
  });
});

/** YYYY-MM-DD, `minDaysOut` days from now (UTC), advanced to `targetDow`
 *  (0=Sun..6=Sat) — slot release refuses dates in the past (same helper as
 *  bookings.test.ts). */
function futureWeekday(minDaysOut: number, targetDow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + minDaysOut);
  while (d.getUTCDay() !== targetDow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!runIntegration)('public coupons listing for slot carts', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let arenaId: string;
  let slotId: string;
  const SUFFIX = Date.now() + 2;
  // Wednesday + the following Thursday, at least two weeks out.
  const wedDate = futureWeekday(14, 3);
  const thuDate = addDays(wedDate, 1);

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'SlotCouponCo', slug: `slotcoupon-${SUFFIX}`, country: 'India', acceptTerms: true },
    });
    tenantId = (t.json() as { id: string }).id;

    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Coupon Courts' },
    });
    const venueId = (v.json() as { id: string }).id;
    const a = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Court C' },
    });
    arenaId = (a.json() as { id: string }).id;

    await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaId}/slots/release`,
      headers: { ...bearer('owner'), 'idempotency-key': `slotcoupon-${SUFFIX}` },
      payload: {
        startDate: wedDate,
        endDate: wedDate,
        quantizationMin: 60,
        cells: [{ dayOfWeek: 3, startTimeMin: 600, durationMin: 60, price: 50000 }],
      },
    });
    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=${wedDate}T00:00:00Z&to=${thuDate}T00:00:00Z`,
      headers: bearer('owner'),
    });
    slotId = (slotsRes.json() as Array<{ id: string; status: string }>).find((s) => s.status === 'open')!.id;

    // One public org-wide coupon (should list) + one private (must not).
    await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/coupons`,
      headers: bearer('owner'),
      payload: { code: `SLOTPUB${SUFFIX}`, scopeType: 'org', discountType: 'percent', discountValue: 1000, visibility: 'public' },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/coupons`,
      headers: bearer('owner'),
      payload: { code: `SLOTPRIV${SUFFIX}`, scopeType: 'org', discountType: 'percent', discountValue: 1000, visibility: 'private' },
    });
  });

  afterAll(async () => {
    // FK dependency order: slots → releases → arena → venue → tenant.
    await db.execute(sql`delete from coupons where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slots where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from slot_releases where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from arenas where venue_id in (select id from venues where tenant_id = ${tenantId})`);
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await app.close();
    await closeDb();
  });

  it('lists public org coupons for a slot cart, hides private ones', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/consumer/coupons?itemType=slot&slotIds=${slotId}`,
    });
    expect(res.statusCode).toBe(200);
    const codes = (res.json() as { rows: Array<{ code: string }> }).rows.map((r) => r.code);
    expect(codes).toContain(`SLOTPUB${SUFFIX}`);
    expect(codes).not.toContain(`SLOTPRIV${SUFFIX}`);
  });

  it('rejects malformed slotIds', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/consumer/coupons?itemType=slot&slotIds=not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
  });
});
