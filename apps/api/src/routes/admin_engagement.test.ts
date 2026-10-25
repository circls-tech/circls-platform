import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      padmin:   { uid: 'fbuid_padmin_eng', email: 'padmin_eng@x.com', email_verified: true },
      pstaff:   { uid: 'fbuid_pstaff_eng', email: 'pstaff_eng@x.com', email_verified: true },
      owner:    { uid: 'fbuid_powner_eng', email: 'powner_eng@x.com', email_verified: true },
      consumer: { uid: 'fbuid_consumer_eng', email: 'consumer_eng@x.com', email_verified: true },
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

interface Row {
  itemType: string;
  itemId: string;
  seriesId: string | null;
  dates: number;
  timeZone: string | null;
  name: string;
  status: string;
  shelf: string;
  url: string | null;
  tenantName: string;
  views: number;
  viewers: number;
  likes: number;
  shares: number;
  sales: number;
}
interface Totals { listings: number; views: number; likes: number; shares: number; sales: number }
interface Page { rows: Row[]; totals: Totals; nextCursor: string | null }

describe.skipIf(!runIntegration)('admin engagement report', () => {
  let app: FastifyInstance;
  const SUFFIX = Date.now();
  const TAG = `engage${SUFFIX}`;
  const slugA = `admin-engage-a-${SUFFIX}`;
  const PLATFORM_SLUG = `circls-internal-test-eng-${SUFFIX}`;
  let prevSlug: string | undefined;
  let platformTenantId: string;
  let tenantAId: string;
  let adminUserId: string;
  let consumerUserId: string;
  let hotId: string;
  let coldId: string;
  let draftId: string;
  const seriesId = crypto.randomUUID();
  let seriesPastId: string;
  let seriesNextId: string;
  let endedId: string;
  let cancelledId: string;
  let rejectedId: string;

  const userId = async (token: string) => {
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    return (me.json() as { id: string }).id;
  };

  const insertEvent = async (
    name: string,
    status: string,
    opts: { inDays?: number; series?: string; tz?: string } = {},
  ) => {
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO events (tenant_id, name, starts_at, ends_at, status, address_json, tz_name, series_id)
      VALUES (${tenantAId}::uuid, ${name},
              now() + make_interval(days => ${opts.inDays ?? 7}),
              now() + make_interval(days => ${opts.inDays ?? 7}, hours => 2),
              ${status}::event_status, '{"city":"Nagpur"}'::jsonb, ${opts.tz ?? 'Asia/Kolkata'},
              ${opts.series ?? null}::uuid)
      RETURNING id
    `);
    return ((rows as unknown as { id: string }[])[0]!).id;
  };

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    adminUserId = await userId('padmin');
    const staffUserId = await userId('pstaff');
    consumerUserId = await userId('consumer');

    const pt = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = ((pt as unknown as { id: string }[])[0]!).id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${adminUserId}::uuid, 'manager'),
             (${platformTenantId}::uuid, ${staffUserId}::uuid, 'staff')
    `);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: `Co ${slugA}`, slug: slugA, country: 'India', acceptTerms: true },
    });
    expect(created.statusCode).toBe(200);
    tenantAId = (created.json() as { id: string }).id;

    hotId = await insertEvent(`${TAG} Hot`, 'published');
    coldId = await insertEvent(`${TAG} Cold`, 'published');
    draftId = await insertEvent(`${TAG} Draft`, 'draft');
    // A weekly series in Boston: last week's date and next week's.
    seriesPastId = await insertEvent(`${TAG} Weekly`, 'completed', { inDays: -7, series: seriesId, tz: 'America/New_York' });
    seriesNextId = await insertEvent(`${TAG} Weekly`, 'published', { inDays: 7, series: seriesId, tz: 'America/New_York' });
    // Off the default Active shelf: one that ran (still `published`, the sweep
    // has not reached it), one called off and one Circls turned down.
    endedId = await insertEvent(`${TAG} Ended`, 'published', { inDays: -3 });
    cancelledId = await insertEvent(`${TAG} Cancelled`, 'cancelled');
    rejectedId = await insertEvent(`${TAG} Rejected`, 'rejected');

    // The Flutter app's view, through the real ingest, which stores it under
    // the web's name.
    const ingest = await app.inject({
      method: 'POST',
      url: '/v1/consumer/activity',
      headers: bearer('padmin'),
      payload: {
        app: 'android',
        events: [{ eventType: 'event_view', itemType: 'event', itemId: hotId, sessionId: 'e2', clientTs: new Date().toISOString() }],
      },
    });
    expect(ingest.statusCode).toBe(200);

    // Hot: two web views from one person (plus that Flutter view from
    // another), and one view 40 days ago; shares sent, copied, sent to WhatsApp and dismissed;
    // a like that is not a view; and a view of the draft, which must not
    // surface at all. The series: one view of each date, by two people.
    await db.execute(sql`
      INSERT INTO consumer_activity (user_id, session_id, event_type, item_type, item_id, props, client_ts, created_at)
      VALUES
        (${consumerUserId}::uuid, 'e1', 'item_view',  'event', ${hotId}::uuid, NULL, now(), now()),
        (${consumerUserId}::uuid, 'e1', 'item_view',  'event', ${hotId}::uuid, NULL, now(), now()),
        (${consumerUserId}::uuid, 'e0', 'item_view',  'event', ${hotId}::uuid, NULL, now(), now() - interval '40 days'),
        (${consumerUserId}::uuid, 'e1', 'item_view',  'event', ${seriesPastId}::uuid, NULL, now(), now()),
        (${adminUserId}::uuid,    'e2', 'item_view',  'event', ${seriesNextId}::uuid, NULL, now(), now()),
        (${consumerUserId}::uuid, 'e1', 'share', 'event', ${hotId}::uuid, '{"outcome":"shared"}'::jsonb, now(), now()),
        (${adminUserId}::uuid,    'e2', 'share', 'event', ${hotId}::uuid, '{"outcome":"copied"}'::jsonb, now(), now()),
        (${consumerUserId}::uuid, 'e1', 'share', 'event', ${hotId}::uuid, '{"outcome":"dismissed"}'::jsonb, now(), now()),
        (${adminUserId}::uuid,    'e2', 'share', 'event', ${hotId}::uuid, '{"outcome":"whatsapp","from":"booking"}'::jsonb, now(), now()),
        (${consumerUserId}::uuid, 'e1', 'like',  'event', ${hotId}::uuid, NULL, now(), now()),
        (${consumerUserId}::uuid, 'e1', 'item_view', 'event', ${draftId}::uuid, NULL, now(), now())
    `);
    // The consumer liked both dates of the series: one person, so one like.
    await db.execute(sql`
      INSERT INTO wishlist_items (user_id, item_type, item_id)
      VALUES (${consumerUserId}::uuid, 'event', ${hotId}::uuid), (${adminUserId}::uuid, 'event', ${hotId}::uuid),
             (${consumerUserId}::uuid, 'event', ${seriesPastId}::uuid), (${consumerUserId}::uuid, 'event', ${seriesNextId}::uuid)
    `);
    // One app booking that went through, holding three tickets; a pending
    // checkout and a door walk-in, neither of which is the end of an app funnel.
    const booked = await db.execute<{ id: string }>(sql`
      INSERT INTO bookings (tenant_id, item_type, channel, payment_method, status, customer_user_id, item_data)
      VALUES
        (${tenantAId}::uuid, 'event', 'circls', 'free', 'confirmed', ${consumerUserId}::uuid, ${JSON.stringify({ eventId: hotId })}::jsonb),
        (${tenantAId}::uuid, 'event', 'circls', 'free', 'pending',   ${consumerUserId}::uuid, ${JSON.stringify({ eventId: hotId })}::jsonb),
        (${tenantAId}::uuid, 'event', 'walkin', 'free', 'confirmed', NULL,                     ${JSON.stringify({ eventId: hotId })}::jsonb)
      RETURNING id
    `);
    const tier = await db.execute<{ id: string }>(sql`
      INSERT INTO event_ticket_tiers (event_id, tenant_id, name)
      VALUES (${hotId}::uuid, ${tenantAId}::uuid, 'General')
      RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO event_booking_tickets (booking_id, tier_id, quantity, unit_price_paise)
      VALUES (${(booked as unknown as { id: string }[])[0]!.id}::uuid,
              ${(tier as unknown as { id: string }[])[0]!.id}::uuid, 3, 0)
    `);
  });

  afterAll(async () => {
    if (seriesNextId) {
      const ids = sql`(${hotId}::uuid, ${draftId}::uuid, ${seriesPastId}::uuid, ${seriesNextId}::uuid)`;
      await db.execute(sql`DELETE FROM consumer_activity WHERE item_id IN ${ids}`);
      await db.execute(sql`DELETE FROM wishlist_items WHERE item_id IN ${ids}`);
    }
    if (tenantAId) {
      await db.execute(sql`DELETE FROM bookings WHERE tenant_id = ${tenantAId}::uuid`);
      await db.execute(sql`DELETE FROM events WHERE tenant_id = ${tenantAId}::uuid`);
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

  const get = (query: string, token = 'padmin') =>
    app.inject({ method: 'GET', url: `/v1/admin/engagement?${query}`, headers: bearer(token) });

  it('counts views, viewers, likes, shares and app sales per event, busiest first', async () => {
    const res = await get(`type=event&q=${TAG}`);
    expect(res.statusCode).toBe(200);
    const page = res.json() as Page;
    // Active by default, so the draft and the ended, cancelled and rejected
    // events are left out; the series is one row, under its next date; the
    // cold event is listed with zeros.
    expect(page.rows.map((r) => r.itemId)).toEqual([hotId, seriesNextId, coldId]);
    const hot = page.rows[0]!;
    expect(hot).toMatchObject({
      itemType: 'event',
      name: `${TAG} Hot`,
      status: 'published',
      shelf: 'active',
      tenantName: `Co ${slugA}`,
      seriesId: null,
      dates: 1,
      timeZone: 'Asia/Kolkata',
      views: 4, // both clients' view events; the share and like rows are not views
      viewers: 2,
      likes: 2,
      shares: 3, // shared, copied and WhatsApp; the dismissed sheet is not a share
      sales: 3, // the confirmed app booking's three tickets; pending and walk-in left out
    });
    expect(page.rows[2]).toMatchObject({ views: 0, viewers: 0, likes: 0, shares: 0, sales: 0 });
    expect(page.totals).toEqual({ listings: 3, views: 6, likes: 3, shares: 3, sales: 3 });
    expect(page.nextCursor).toBeNull();
  });

  it('shelf picks which events are listed', async () => {
    const ids = async (shelf: string) => {
      const res = await get(`type=event&q=${TAG}&shelf=${shelf}`);
      expect(res.statusCode).toBe(200);
      return (res.json() as Page).rows.map((r) => r.itemId);
    };
    // The series stays Active: its next date stands for it, though last
    // week's is already completed.
    expect(await ids('completed')).toEqual([endedId]);
    expect(await ids('cancelled')).toEqual([cancelledId]);
    expect(await ids('rejected')).toEqual([rejectedId]);
    expect((await ids('all')).sort()).toEqual(
      [hotId, coldId, seriesNextId, endedId, cancelledId, rejectedId].sort(),
    );
  });

  it('links only what customers can open on the consumer site', async () => {
    const res = await get(`type=event&q=${TAG}&shelf=all`);
    expect(res.statusCode).toBe(200);
    const url = new Map((res.json() as Page).rows.map((r) => [r.itemId, r.url]));
    expect(url.get(hotId)).toMatch(new RegExp(`/events/${hotId}$`));
    // A series links the date that stands for it.
    expect(url.get(seriesNextId)).toMatch(new RegExp(`/events/${seriesNextId}$`));
    expect(url.get(endedId)).toBeNull();
    expect(url.get(cancelledId)).toBeNull();
    expect(url.get(rejectedId)).toBeNull();
  });

  it('rejects a shelf the type does not have', async () => {
    expect((await get('type=event&shelf=closed')).statusCode).toBe(400);
    expect((await get('type=venue&shelf=completed')).statusCode).toBe(400);
    expect((await get('type=membership&shelf=inactive')).statusCode).toBe(200);
  });

  it('counts a recurring event once, across all its dates', async () => {
    const res = await get(`type=event&q=${TAG}%20Weekly`);
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as Page).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId: seriesNextId, // the next date stands for the series
      seriesId,
      dates: 2,
      status: 'published',
      timeZone: 'America/New_York', // its own zone, not IST
      views: 2, // one per date
      viewers: 2,
      likes: 1, // the same person liked both dates
    });
  });

  it('since narrows the counts to recent activity', async () => {
    const since = encodeURIComponent(new Date(Date.now() - 7 * 86_400_000).toISOString());
    const res = await get(`type=event&q=${TAG}&since=${since}`);
    expect(res.statusCode).toBe(200);
    const hot = (res.json() as Page).rows.find((r) => r.itemId === hotId)!;
    expect(hot.views).toBe(3);
    expect(hot.viewers).toBe(2);
  });

  it('pages by offset', async () => {
    const first = (await get(`type=event&q=${TAG}&limit=1`)).json() as Page;
    expect(first.rows.map((r) => r.itemId)).toEqual([hotId]);
    expect(first.nextCursor).toBe('1');
    const second = (await get(`type=event&q=${TAG}&limit=1&cursor=1`)).json() as Page;
    expect(second.rows.map((r) => r.itemId)).toEqual([seriesNextId]);
    expect(second.nextCursor).toBe('2');
    // Totals cover every matching listing, not just the page.
    expect(second.totals.listings).toBe(3);
  });

  it('format=csv downloads every matching row', async () => {
    const res = await get(`type=event&q=${TAG}&format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('engagement-events.csv');
    expect(res.body).toContain('"Listing ID","Series ID","Type","Name","Dates"');
    expect(res.body).toContain(`${TAG} Hot`);
    expect(res.body).not.toContain(`${TAG} Draft`);
  });

  it('platform Staff can read it (counts only, no contact details)', async () => {
    const res = await get(`type=event&q=${TAG}`, 'pstaff');
    expect(res.statusCode).toBe(200);
  });

  it('rejects an unknown type', async () => {
    const res = await get('type=arena');
    expect(res.statusCode).toBe(400);
  });

  it('a partner gets 403', async () => {
    const res = await get('type=event', 'owner');
    expect(res.statusCode).toBe(403);
  });
});
