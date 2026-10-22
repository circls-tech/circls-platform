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
  name: string;
  status: string;
  tenantName: string;
  views: number;
  viewers: number;
  likes: number;
  shares: number;
  bookings: number;
}
interface Totals { listings: number; views: number; likes: number; shares: number; bookings: number }
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

  const userId = async (token: string) => {
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    return (me.json() as { id: string }).id;
  };

  const insertEvent = async (name: string, status: string) => {
    const rows = await db.execute<{ id: string }>(sql`
      INSERT INTO events (tenant_id, name, starts_at, ends_at, status, address_json, tz_name)
      VALUES (${tenantAId}::uuid, ${name}, now() + interval '7 days', now() + interval '7 days 2 hours',
              ${status}::event_status, '{"city":"Nagpur"}'::jsonb, 'Asia/Kolkata')
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

    // Hot: two web views and a Flutter view from two people, plus one view
    // 40 days ago; shares sent, copied and dismissed; a like that is not a
    // view; and a view of the draft, which must not surface at all.
    await db.execute(sql`
      INSERT INTO consumer_activity (user_id, session_id, event_type, item_type, item_id, props, client_ts, created_at)
      VALUES
        (${consumerUserId}::uuid, 'e1', 'item_view',  'event', ${hotId}::uuid, NULL, now(), now()),
        (${consumerUserId}::uuid, 'e1', 'item_view',  'event', ${hotId}::uuid, NULL, now(), now()),
        (${adminUserId}::uuid,    'e2', 'event_view', 'event', ${hotId}::uuid, NULL, now(), now()),
        (${consumerUserId}::uuid, 'e0', 'item_view',  'event', ${hotId}::uuid, NULL, now(), now() - interval '40 days'),
        (${consumerUserId}::uuid, 'e1', 'share', 'event', ${hotId}::uuid, '{"outcome":"shared"}'::jsonb, now(), now()),
        (${adminUserId}::uuid,    'e2', 'share', 'event', ${hotId}::uuid, '{"outcome":"copied"}'::jsonb, now(), now()),
        (${consumerUserId}::uuid, 'e1', 'share', 'event', ${hotId}::uuid, '{"outcome":"dismissed"}'::jsonb, now(), now()),
        (${consumerUserId}::uuid, 'e1', 'like',  'event', ${hotId}::uuid, NULL, now(), now()),
        (${consumerUserId}::uuid, 'e1', 'item_view', 'event', ${draftId}::uuid, NULL, now(), now())
    `);
    await db.execute(sql`
      INSERT INTO wishlist_items (user_id, item_type, item_id)
      VALUES (${consumerUserId}::uuid, 'event', ${hotId}::uuid), (${adminUserId}::uuid, 'event', ${hotId}::uuid)
    `);
    // One app booking that went through; a pending checkout and a door
    // walk-in, neither of which is the end of an app funnel.
    await db.execute(sql`
      INSERT INTO bookings (tenant_id, item_type, channel, payment_method, status, customer_user_id, item_data)
      VALUES
        (${tenantAId}::uuid, 'event', 'circls', 'free', 'confirmed', ${consumerUserId}::uuid, ${JSON.stringify({ eventId: hotId })}::jsonb),
        (${tenantAId}::uuid, 'event', 'circls', 'free', 'pending',   ${consumerUserId}::uuid, ${JSON.stringify({ eventId: hotId })}::jsonb),
        (${tenantAId}::uuid, 'event', 'walkin', 'free', 'confirmed', NULL,                     ${JSON.stringify({ eventId: hotId })}::jsonb)
    `);
  });

  afterAll(async () => {
    if (hotId) {
      await db.execute(sql`DELETE FROM consumer_activity WHERE item_id IN (${hotId}::uuid, ${draftId}::uuid)`);
      await db.execute(sql`DELETE FROM wishlist_items WHERE item_id = ${hotId}::uuid`);
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

  it('counts views, viewers, likes, shares and app bookings per event, busiest first', async () => {
    const res = await get(`type=event&q=${TAG}`);
    expect(res.statusCode).toBe(200);
    const page = res.json() as Page;
    // The draft is left out; the cold event is listed with zeros.
    expect(page.rows.map((r) => r.itemId)).toEqual([hotId, coldId]);
    const hot = page.rows[0]!;
    expect(hot).toMatchObject({
      itemType: 'event',
      name: `${TAG} Hot`,
      status: 'published',
      tenantName: `Co ${slugA}`,
      views: 4, // both clients' view events; the share and like rows are not views
      viewers: 2,
      likes: 2,
      shares: 2, // shared + copied; the dismissed sheet is not a share
      bookings: 1, // pending and walk-in left out
    });
    expect(page.rows[1]).toMatchObject({ views: 0, viewers: 0, likes: 0, shares: 0, bookings: 0 });
    expect(page.totals).toEqual({ listings: 2, views: 4, likes: 2, shares: 2, bookings: 1 });
    expect(page.nextCursor).toBeNull();
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
    expect(second.rows.map((r) => r.itemId)).toEqual([coldId]);
    expect(second.nextCursor).toBeNull();
    // Totals cover every matching listing, not just the page.
    expect(second.totals.listings).toBe(2);
  });

  it('format=csv downloads every matching row', async () => {
    const res = await get(`type=event&q=${TAG}&format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('engagement-events.csv');
    expect(res.body).toContain('"Listing ID","Type","Name"');
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
