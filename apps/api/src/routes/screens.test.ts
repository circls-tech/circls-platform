/**
 * Server-driven UI: draft → publish → public GET (ETag / 304) → rollback,
 * the manifest's minBuild gating, the admin preview path, and flags.
 * Integration (RUN_INTEGRATION + a real Postgres), as the other route tests.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const RUN = vi.hoisted(() => Date.now());
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      pmanager: { uid: `fbuid_sd_pmanager_${RUN}`, email: `sd_pmanager_${RUN}@x.com`, email_verified: true },
      pstaff: { uid: `fbuid_sd_pstaff_${RUN}`, email: `sd_pstaff_${RUN}@x.com`, email_verified: true },
      partner: { uid: `fbuid_sd_partner_${RUN}`, email: `sd_partner_${RUN}@x.com`, email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { __resetPlatformTenantCacheForTesting } = await import('../lib/authz/platform_tenant.js');
const { __resetScreensCacheForTesting } = await import('../services/screens_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('SDUI screens', () => {
  let app: FastifyInstance;
  const PLATFORM_SLUG = `circls-internal-sd-${RUN}`;
  let prevSlug: string | undefined;
  let platformTenantId: string;
  const userIds: Record<string, string> = {};
  // Unique per run: the public cache + unique indexes are keyed on (app, key).
  const KEY = `explore_${RUN}`;
  const PUB = `/v1/screens/consumer/${KEY}`;
  const ADMIN = `/v1/admin/screens/consumer/${KEY}`;

  const screen = (title: string, extra: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    screen: `consumer.${KEY}`,
    root: { type: 'column', children: [{ type: 'text', props: { title } }] },
    ...extra,
  });
  const putDraft = (token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `${ADMIN}/draft`, headers: bearer(token), payload });
  const publish = (token = 'pmanager') =>
    app.inject({ method: 'POST', url: `${ADMIN}/publish`, headers: bearer(token) });

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();
    __resetScreensCacheForTesting();
    app = await buildServer();
    await app.ready();
    for (const who of ['pmanager', 'pstaff', 'partner']) {
      const res = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(who) });
      expect(res.statusCode).toBe(200);
      userIds[who] = (res.json() as { id: string }).id;
    }
    const pt = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = (pt as unknown as { id: string }[])[0]!.id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role) VALUES
        (${platformTenantId}::uuid, ${userIds['pmanager']}::uuid, 'manager'),
        (${platformTenantId}::uuid, ${userIds['pstaff']}::uuid, 'staff')
    `);
  });

  afterAll(async () => {
    await db.execute(sql`delete from screen_layouts where key = ${KEY}`);
    await db.execute(sql`delete from platform_settings where key in ('sdui.flags.partners', 'sdui.update.partners') and updated_by_user_id = ${userIds['pmanager']}::uuid`);
    await db.execute(sql`delete from audit_log where tenant_id = ${platformTenantId}::uuid`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${platformTenantId}::uuid`);
    await db.execute(sql`delete from tenants where id = ${platformTenantId}::uuid`);
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug ?? 'circls-internal';
    __resetPlatformTenantCacheForTesting();
    __resetScreensCacheForTesting();
    await app.close();
    await closeDb();
  });

  it('nothing is published yet: public 404, manifest without the key', async () => {
    expect((await app.inject({ method: 'GET', url: PUB })).statusCode).toBe(404);
    const m = await app.inject({ method: 'GET', url: '/v1/screens/consumer/manifest?platform=ios&build=1' });
    expect(m.statusCode).toBe(200);
    expect(m.json().screens[KEY]).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/v1/screens/web/manifest' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/screens/consumer/Bad-Key' })).statusCode).toBe(400);
  });

  it('only a platform member with the write capability saves a draft', async () => {
    expect((await putDraft('partner', { body: screen('a') })).statusCode).toBe(403);
    expect((await putDraft('pstaff', { body: screen('a') })).statusCode).toBe(403);
    const bad = await putDraft('pmanager', { body: { ...screen('a'), screen: 'consumer.other' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_screen');
  });

  it('draft → preview → publish → public GET with ETag and 304', async () => {
    const saved = await putDraft('pmanager', { body: screen('v1'), minBuild: { ios: 10 }, note: 'first' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ version: 1, status: 'draft', minBuild: { ios: 10 }, note: 'first' });
    // Re-saving replaces the same draft row.
    const again = await putDraft('pmanager', { body: screen('v1 again'), minBuild: { ios: 10 } });
    expect(again.json().version).toBe(1);
    expect(again.json().id).toBe(saved.json().id);

    // The preview path: staff (read) may see the draft; anonymous may not.
    expect((await app.inject({ method: 'GET', url: `${PUB}?draft=1` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `${PUB}?draft=1`, headers: bearer('partner') })).statusCode).toBe(403);
    const preview = await app.inject({ method: 'GET', url: `${PUB}?draft=1`, headers: bearer('pstaff') });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().root.children[0].props.title).toBe('v1 again');
    expect(preview.headers['cache-control']).toBe('no-store');
    // Still nothing public.
    expect((await app.inject({ method: 'GET', url: PUB })).statusCode).toBe(404);

    expect((await publish('pstaff')).statusCode).toBe(403);
    const pub = await publish();
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ version: 1, status: 'published' });
    expect(pub.json().publishedAt).toBeTruthy();
    expect((await publish()).statusCode).toBe(409);

    const res = await app.inject({ method: 'GET', url: `${PUB}?platform=ios&build=12` });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(`"consumer.${KEY}.1"`);
    expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(res.json()).toMatchObject({ screen: `consumer.${KEY}`, version: 1, minBuild: { ios: 10 } });
    const cached = await app.inject({
      method: 'GET',
      url: `${PUB}?platform=ios&build=12`,
      headers: { 'if-none-match': `"consumer.${KEY}.1"` },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe('');

    // An older iOS build can't render it; Android has no minimum.
    expect((await app.inject({ method: 'GET', url: `${PUB}?platform=ios&build=9` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `${PUB}?platform=android&build=1` })).statusCode).toBe(200);
    const m = await app.inject({ method: 'GET', url: '/v1/screens/consumer/manifest?platform=ios&build=12' });
    expect(m.json().screens[KEY]).toEqual({ version: 1 });
    const old = await app.inject({ method: 'GET', url: '/v1/screens/consumer/manifest?platform=ios&build=9' });
    expect(old.json().screens[KEY]).toBeUndefined();
  });

  it('a second publish wins; a rollback is a new version; the list and history follow', async () => {
    await putDraft('pmanager', { body: screen('v2') });
    expect((await publish()).json().version).toBe(2);
    const v2 = await app.inject({ method: 'GET', url: PUB });
    expect(v2.json().version).toBe(2);
    expect(v2.json().root.children[0].props.title).toBe('v2');

    const rb = await app.inject({ method: 'POST', url: `${ADMIN}/rollback`, headers: bearer('pmanager'), payload: { version: 1 } });
    expect(rb.statusCode).toBe(200);
    expect(rb.json()).toMatchObject({ version: 3, status: 'published', note: 'Rollback to v1' });
    const v3 = await app.inject({ method: 'GET', url: PUB });
    expect(v3.json().version).toBe(3);
    expect(v3.json().root.children[0].props.title).toBe('v1 again');
    expect((await app.inject({ method: 'POST', url: `${ADMIN}/rollback`, headers: bearer('pmanager'), payload: { version: 42 } })).statusCode).toBe(404);

    const list = await app.inject({ method: 'GET', url: '/v1/admin/screens?app=consumer', headers: bearer('pstaff') });
    expect(list.statusCode).toBe(200);
    expect(list.json().screens.find((s: { key: string }) => s.key === KEY)).toMatchObject({
      publishedVersion: 3,
      draftVersion: null,
    });
    const detail = await app.inject({ method: 'GET', url: ADMIN, headers: bearer('pstaff') });
    expect(detail.json().published.version).toBe(3);
    expect(detail.json().draft).toBeNull();
    expect(detail.json().history.map((h: { version: number }) => h.version)).toEqual([3, 2, 1]);
    expect(detail.json().history[0].body).toBeUndefined();
    const one = await app.inject({ method: 'GET', url: `${ADMIN}/versions/2`, headers: bearer('pstaff') });
    expect(one.json().body.root.children[0].props.title).toBe('v2');

    // A draft saved now sits at 4; deleting it leaves the published row alone.
    expect((await putDraft('pmanager', { body: screen('v4') })).json().version).toBe(4);
    expect((await app.inject({ method: 'DELETE', url: `${ADMIN}/draft`, headers: bearer('pmanager') })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: PUB })).json().version).toBe(3);
  });

  it('flags and the update notice', async () => {
    const h = bearer('pmanager');
    const empty = await app.inject({ method: 'GET', url: '/v1/admin/screens/partners/flags', headers: bearer('pstaff') });
    expect(empty.json()).toEqual({ app: 'partners', flags: {} });
    expect((await app.inject({ method: 'PUT', url: '/v1/admin/screens/partners/flags', headers: bearer('pstaff'), payload: { flags: { a: true } } })).statusCode).toBe(403);
    const set = await app.inject({ method: 'PUT', url: '/v1/admin/screens/partners/flags', headers: h, payload: { flags: { 'home.banner': true, beta: false } } });
    expect(set.statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/v1/admin/screens/partners/flags', headers: h, payload: { flags: { 'bad flag': true } } })).statusCode).toBe(400);
    const m = await app.inject({ method: 'GET', url: '/v1/screens/partners/manifest' });
    expect(m.json().flags).toEqual({ 'home.banner': true, beta: false });
    expect(m.json().update).toBeNull();

    const notice = { minSupportedBuild: { ios: 3, android: 4 }, message: { title: 'Update', body: 'Please', url: 'https://circls.app' } };
    expect((await app.inject({ method: 'PUT', url: '/v1/admin/screens/partners/update', headers: h, payload: notice })).json().update).toEqual(notice);
    expect((await app.inject({ method: 'GET', url: '/v1/screens/partners/manifest' })).json().update).toEqual(notice);
    expect((await app.inject({ method: 'PUT', url: '/v1/admin/screens/partners/update', headers: h, payload: { update: null } })).json().update).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/v1/admin/screens/partners/update', headers: h })).json().update).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/v1/screens/partners/manifest' })).json().update).toBeNull();
  });
});
