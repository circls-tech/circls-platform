import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      padmin: { uid: 'fbuid_lpv_padmin', email: 'lpv_padmin@x.com', email_verified: true },
      ownerA: { uid: 'fbuid_lpv_owner_a', email: 'lpv_owner_a@x.com', email_verified: true },
      readerA: { uid: 'fbuid_lpv_reader_a', email: 'lpv_reader_a@x.com', email_verified: true },
      ownerB: { uid: 'fbuid_lpv_owner_b', email: 'lpv_owner_b@x.com', email_verified: true },
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

interface Preview {
  url: string;
  type: string;
  id: string;
  expiresAt: string;
}

async function meId(app: FastifyInstance, token: string): Promise<string> {
  const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
  expect(me.statusCode).toBe(200);
  return (me.json() as { id: string }).id;
}

async function createTenantViaApi(app: FastifyInstance, token: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tenants',
    headers: bearer(token),
    payload: { name: `Co ${slug}`, slug, country: 'India', acceptTerms: true },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { id: string }).id;
}

describe.skipIf(!runIntegration)('listing preview routes', () => {
  let app: FastifyInstance;
  const SUFFIX = Date.now();
  const PLATFORM_SLUG = `circls-internal-lpv-${SUFFIX}`;
  let prevSlug: string | undefined;
  let platformTenantId: string;
  let tenantAId: string;
  let tenantBId: string;
  let draftEventId: string;
  let pendingVenueId: string;
  let pendingArenaId: string;
  let pendingMembershipId: string;

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    const adminUserId = await meId(app, 'padmin');
    const readerAId = await meId(app, 'readerA');

    const ptRows = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = ((ptRows as unknown as { id: string }[])[0]!).id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${adminUserId}::uuid, 'manager')
    `);

    tenantAId = await createTenantViaApi(app, 'ownerA', `lpv-a-${SUFFIX}`);
    tenantBId = await createTenantViaApi(app, 'ownerB', `lpv-b-${SUFFIX}`);
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${tenantAId}::uuid, ${readerAId}::uuid, 'readonly')
    `);

    const ev = await db.execute<{ id: string }>(sql`
      INSERT INTO events (tenant_id, venue_id, address_json, tz_name, name, starts_at, ends_at, price_paise, status)
      VALUES (${tenantAId}::uuid, NULL, '{"line1":"1 Draft Rd","city":"Pune"}'::jsonb, 'Asia/Kolkata',
              'Draft Event', '2031-03-01T10:00:00Z', '2031-03-01T12:00:00Z', 0, 'draft')
      RETURNING id
    `);
    draftEventId = ((ev as unknown as { id: string }[])[0]!).id;
    const v = await db.execute<{ id: string }>(sql`
      INSERT INTO venues (tenant_id, name, tz_name, status)
      VALUES (${tenantAId}::uuid, 'Pending Venue', 'Asia/Kolkata', 'pending_review')
      RETURNING id
    `);
    pendingVenueId = ((v as unknown as { id: string }[])[0]!).id;
    const a = await db.execute<{ id: string }>(sql`
      INSERT INTO arenas (venue_id, name, status)
      VALUES (${pendingVenueId}::uuid, 'Pending Court', 'pending_review')
      RETURNING id
    `);
    pendingArenaId = ((a as unknown as { id: string }[])[0]!).id;
    const m = await db.execute<{ id: string }>(sql`
      INSERT INTO memberships (tenant_id, venue_id, name, duration_days, status)
      VALUES (${tenantAId}::uuid, NULL, 'Pending Plan', 30, 'pending_review')
      RETURNING id
    `);
    pendingMembershipId = ((m as unknown as { id: string }[])[0]!).id;
  });

  afterAll(async () => {
    const owned = sql`select id from tenants where slug like ${`lpv-%-${SUFFIX}`}`;
    await db.execute(sql`delete from audit_log where tenant_id in (${owned})`);
    await db.execute(sql`delete from memberships where tenant_id in (${owned})`);
    await db.execute(sql`delete from events where tenant_id in (${owned})`);
    await db.execute(sql`delete from arenas where venue_id in (select id from venues where tenant_id in (${owned}))`);
    await db.execute(sql`delete from venues where tenant_id in (${owned})`);
    await db.execute(sql`delete from tenant_members where tenant_id in (${owned})`);
    await db.execute(sql`delete from tenants where slug like ${`lpv-%-${SUFFIX}`}`);
    if (platformTenantId) {
      await db.execute(sql`DELETE FROM tenant_members WHERE tenant_id = ${platformTenantId}::uuid`);
      await db.execute(sql`DELETE FROM tenants WHERE id = ${platformTenantId}::uuid`);
    }
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug ?? 'circls-internal';
    __resetPlatformTenantCacheForTesting();
    await app.close();
    await closeDb();
  });

  it('a partner mints a preview of their own draft event, and it opens the public read', async () => {
    // Not public: a draft.
    const closed = await app.inject({ method: 'GET', url: `/v1/consumer/events/${draftEventId}` });
    expect(closed.statusCode).toBe(404);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantAId}/listings/event/${draftEventId}/preview`,
      headers: bearer('ownerA'),
    });
    expect(res.statusCode).toBe(200);
    const p = res.json() as Preview;
    expect(p.type).toBe('event');
    expect(p.id).toBe(draftEventId);
    const url = new URL(p.url);
    expect(url.pathname).toBe(`/events/${draftEventId}`);
    const token = url.searchParams.get('preview')!;
    expect(token).toBeTruthy();

    const open = await app.inject({
      method: 'GET',
      url: `/v1/consumer/events/${draftEventId}`,
      headers: { 'x-circls-preview': token },
    });
    expect(open.statusCode).toBe(200);
    expect((open.json() as { name: string }).name).toBe('Draft Event');

    // The token travels in a header only: on the query string it is ignored,
    // so it never has to appear in a logged request URL.
    const viaQuery = await app.inject({
      method: 'GET',
      url: `/v1/consumer/events/${draftEventId}?preview=${encodeURIComponent(token)}`,
    });
    expect(viaQuery.statusCode).toBe(404);

    // The token is for that event alone.
    const other = await app.inject({
      method: 'GET',
      url: `/v1/consumer/memberships/${pendingMembershipId}`,
      headers: { 'x-circls-preview': token },
    });
    expect(other.statusCode).toBe(404);
  });

  it('a read-only member can preview too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantAId}/listings/membership/${pendingMembershipId}/preview`,
      headers: bearer('readerA'),
    });
    expect(res.statusCode).toBe(200);
    expect(new URL((res.json() as Preview).url).pathname).toBe(`/memberships/${pendingMembershipId}`);
  });

  it('another organisation cannot preview it, and cannot tell it exists', async () => {
    // Through their own tenant: the listing is not theirs → 404.
    const viaOwn = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantBId}/listings/event/${draftEventId}/preview`,
      headers: bearer('ownerB'),
    });
    expect(viaOwn.statusCode).toBe(404);
    // Through the owner's tenant: not a member → 403.
    const viaTheirs = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantAId}/listings/event/${draftEventId}/preview`,
      headers: bearer('ownerB'),
    });
    expect(viaTheirs.statusCode).toBe(403);
  });

  it('partners preview arenas through their venue page only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantAId}/listings/arena/${pendingArenaId}/preview`,
      headers: bearer('ownerA'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('a Circls reviewer mints previews from the queue; an arena resolves to its venue page', async () => {
    const arena = await app.inject({
      method: 'POST',
      url: `/v1/admin/listings/arena/${pendingArenaId}/preview`,
      headers: bearer('padmin'),
    });
    expect(arena.statusCode).toBe(200);
    const p = arena.json() as Preview;
    expect(p.type).toBe('venue');
    expect(p.id).toBe(pendingVenueId);
    const token = new URL(p.url).searchParams.get('preview')!;

    // The venue page opens, with its pending arena listed.
    const venue = await app.inject({
      method: 'GET',
      url: `/v1/consumer/venues/${pendingVenueId}`,
      headers: { 'x-circls-preview': token },
    });
    expect(venue.statusCode).toBe(200);
    const body = venue.json() as { venue: { id: string }; arenas: { id: string }[] };
    expect(body.venue.id).toBe(pendingVenueId);
    expect(body.arenas.map((a) => a.id)).toEqual([pendingArenaId]);

    const event = await app.inject({
      method: 'POST',
      url: `/v1/admin/listings/event/${draftEventId}/preview`,
      headers: bearer('padmin'),
    });
    expect(event.statusCode).toBe(200);
    expect((event.json() as Preview).type).toBe('event');
  });

  it('a partner is refused the reviewer endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/listings/event/${draftEventId}/preview`,
      headers: bearer('ownerA'),
    });
    expect(res.statusCode).toBe(403);
  });
});
