import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// tenants.hidden_from_catalog: a demo/test org disappears from everything a
// consumer sees (directory, profile, venues, events, memberships, questions)
// while it keeps working for its own members, and comes back when unhidden.
// Integration (RUN_INTEGRATION + a real Postgres).
const RUN = vi.hoisted(() => Date.now());
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      padmin: { uid: `fbuid_padmin_ch_${RUN}`, email: `padmin_ch_${RUN}@x.com`, email_verified: true },
      owner: { uid: `fbuid_owner_ch_${RUN}`, email: `owner_ch_${RUN}@x.com`, email_verified: true },
      shopper: { uid: `fbuid_shopper_ch_${RUN}`, email: `shopper_ch_${RUN}@x.com`, email_verified: true },
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
const first = <T>(res: unknown) => (res as unknown as T[])[0]!;

describe.skipIf(!runIntegration)('organisations hidden from the consumer catalogue', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let eventId: string;
  let membershipId: string;
  const SLUG = `ch-demo-${RUN}`;
  const VENUE = `CH Demo Courts ${RUN}`;
  const PLATFORM_SLUG = `circls-internal-ch-${RUN}`;
  let prevSlug: string | undefined;

  const get = (url: string, who?: string) =>
    app.inject({ method: 'GET', url, ...(who ? { headers: bearer(who) } : {}) });
  const ids = async (url: string, key: 'id' | 'slug' = 'id') =>
    ((await get(url)).json() as { rows: Record<string, string>[] }).rows.map((r) => r[key]);
  const setHidden = (hidden: boolean, who = 'padmin') =>
    app.inject({
      method: 'PATCH',
      url: `/v1/admin/tenants/${tenantId}/catalog`,
      headers: bearer(who),
      payload: { hiddenFromCatalog: hidden },
    });

  const EVERYWHERE = {
    directory: true,
    profile: true,
    venueSearch: true,
    venue: true,
    events: true,
    event: true,
    memberships: true,
    membership: true,
  };

  /** Every consumer surface the org could show up on, true = visible. */
  const visibility = async () => ({
    directory: (await ids('/v1/consumer/orgs', 'slug')).includes(SLUG),
    profile: (await get(`/v1/consumer/orgs/${SLUG}`)).statusCode === 200,
    venueSearch: (await ids(`/v1/consumer/venues?search=${encodeURIComponent(VENUE)}`)).includes(venueId),
    venue: (await get(`/v1/consumer/venues/${venueId}`)).statusCode === 200,
    events: (await ids('/v1/consumer/events?limit=100')).includes(eventId),
    event: (await get(`/v1/consumer/events/${eventId}`)).statusCode === 200,
    memberships: (await ids('/v1/consumer/memberships?limit=100')).includes(membershipId),
    membership: (await get(`/v1/consumer/memberships/${membershipId}`)).statusCode === 200,
  });

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();
    app = await buildServer();
    await app.ready();

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('padmin') });
    const padminId = (me.json() as { id: string }).id;
    const pt = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial') RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${first<{ id: string }>(pt).id}::uuid, ${padminId}::uuid, 'owner')
    `);
    await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('shopper') });

    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: `CH Demo ${RUN}`, slug: SLUG, country: 'India', acceptTerms: true },
    });
    expect(t.statusCode).toBe(200);
    tenantId = (t.json() as { id: string }).id;

    venueId = first<{ id: string }>(
      await db.execute<{ id: string }>(sql`
        INSERT INTO venues (tenant_id, name, status) VALUES (${tenantId}::uuid, ${VENUE}, 'active') RETURNING id
      `),
    ).id;
    await db.execute(sql`
      INSERT INTO arenas (venue_id, name, status) VALUES (${venueId}::uuid, 'Court 1', 'active')
    `);
    // Started long ago, ends tomorrow: first in the soonest-first events list.
    eventId = first<{ id: string }>(
      await db.execute<{ id: string }>(sql`
        INSERT INTO events (tenant_id, venue_id, name, status, starts_at, ends_at)
        VALUES (${tenantId}::uuid, ${venueId}::uuid, 'CH Cup', 'published', now() - interval '3650 days',
                now() + interval '1 day')
        RETURNING id
      `),
    ).id;
    membershipId = first<{ id: string }>(
      await db.execute<{ id: string }>(sql`
        INSERT INTO memberships (tenant_id, name, duration_days, status)
        VALUES (${tenantId}::uuid, 'CH Gold', 30, 'active') RETURNING id
      `),
    ).id;
  });

  afterAll(async () => {
    await app.close();
    if (prevSlug === undefined) delete process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    else process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug;
    await closeDb();
  });

  it('is visible everywhere before it is hidden', async () => {
    expect(await visibility()).toEqual(EVERYWHERE);
  });

  it('only a platform admin can hide it', async () => {
    expect((await setHidden(true, 'owner')).statusCode).toBe(403);
    const res = await setHidden(true);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { hiddenFromCatalog: boolean }).hiddenFromCatalog).toBe(true);
  });

  it('hidden: gone from every consumer surface', async () => {
    expect(await visibility()).toEqual({
      directory: false,
      profile: false,
      venueSearch: false,
      venue: false,
      events: false,
      event: false,
      memberships: false,
      membership: false,
    });
    // Nobody can ask a question on it either.
    const ask = await app.inject({
      method: 'POST',
      url: '/v1/consumer/questions',
      headers: bearer('shopper'),
      payload: { subjectType: 'event', subjectId: eventId, visibility: 'public', body: 'Is there parking?' },
    });
    expect(ask.statusCode).toBe(404);
  });

  it('hidden: still works for its own members', async () => {
    const venues = await get(`/v1/tenants/${tenantId}/venues`, 'owner');
    expect(venues.statusCode).toBe(200);
    expect(JSON.stringify(venues.json())).toContain(venueId);
  });

  it('shown again: back everywhere', async () => {
    expect((await setHidden(false)).statusCode).toBe(200);
    expect(await visibility()).toEqual(EVERYWHERE);
  });
});
