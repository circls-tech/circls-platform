import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Circls super admins: who may switch it on, what they may do in a partner
// org they don't belong to, and what that org sees. Integration-gated.
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      powner: { uid: 'fbuid_sa_powner', email: 'sa_powner@x.com', email_verified: true },
      pmanager: { uid: 'fbuid_sa_pmanager', email: 'sa_pmanager@x.com', email_verified: true },
      sadmin: { uid: 'fbuid_sa_sadmin', email: 'sa_sadmin@x.com', email_verified: true },
      owner: { uid: 'fbuid_sa_owner', email: 'sa_owner@x.com', email_verified: true },
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

function errorCode(res: { body: string }): string | null {
  if (!res.body) return null;
  return (JSON.parse(res.body) as { error?: { code?: string } }).error?.code ?? null;
}

describe.skipIf(!runIntegration)('super admins', () => {
  let app: FastifyInstance;
  const SUFFIX = Date.now();
  const PLATFORM_SLUG = `circls-internal-sa-${SUFFIX}`;
  let prevSlug: string | undefined;
  let platformTenantId: string;
  let partnerTenantId: string;
  const userIds: Record<string, string> = {};

  const call = (token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(token), ...(payload ? { payload } : {}) });

  const supportUrl = () => `/v1/tenants/${partnerTenantId}/circls-support`;
  const visitUrl = () => `/v1/super-admin/tenants/${partnerTenantId}/visit`;
  const HOUR = 60 * 60 * 1000;

  const setSuperAdmin = (token: string, userId: string, superAdmin: boolean, tenantId = platformTenantId) =>
    call(token, 'PATCH', `/v1/tenants/${tenantId}/members/${userId}/super-admin`, { superAdmin });

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    for (const token of ['powner', 'pmanager', 'sadmin', 'owner']) {
      userIds[token] = (await call(token, 'GET', '/v1/me')).json().id;
    }

    const pt = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = (pt as unknown as { id: string }[])[0]!.id;
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role) VALUES
        (${platformTenantId}::uuid, ${userIds['powner']}::uuid, 'owner'),
        (${platformTenantId}::uuid, ${userIds['pmanager']}::uuid, 'manager'),
        (${platformTenantId}::uuid, ${userIds['sadmin']}::uuid, 'staff')
    `);

    const t = await call('owner', 'POST', '/v1/tenants', {
      name: `Solo Sports ${SUFFIX}`,
      slug: `solo-sports-${SUFFIX}`,
      country: 'India',
      acceptTerms: true,
    });
    expect(t.statusCode).toBe(200);
    partnerTenantId = t.json().id;
  });

  afterAll(async () => {
    if (prevSlug === undefined) delete process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    else process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug;
    __resetPlatformTenantCacheForTesting();
    await app?.close();
    await closeDb();
  });

  it('a Circls team member without the switch stays out of partner orgs', async () => {
    const res = await call('sadmin', 'GET', `/v1/tenants/${partnerTenantId}`);
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('tenant_forbidden');
    const search = await call('sadmin', 'GET', '/v1/super-admin/tenants');
    expect(errorCode(search)).toBe('super_admin_required');
    const visit = await call('sadmin', 'POST', `/v1/super-admin/tenants/${partnerTenantId}/visit`);
    expect(errorCode(visit)).toBe('super_admin_required');
  });

  it('only a platform Owner turns the switch on, and only on the Circls team', async () => {
    const byManager = await setSuperAdmin('pmanager', userIds['sadmin']!, true);
    expect(errorCode(byManager)).toBe('forbidden_capability');

    const onPartner = await setSuperAdmin('owner', userIds['owner']!, true, partnerTenantId);
    expect(onPartner.statusCode).toBe(404);
    expect(errorCode(onPartner)).toBe('not_platform_tenant');

    const notMember = await setSuperAdmin('powner', userIds['owner']!, true);
    expect(errorCode(notMember)).toBe('member_not_found');

    const ok = await setSuperAdmin('powner', userIds['sadmin']!, true);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().superAdmin).toBe(true);

    const members = (await call('powner', 'GET', `/v1/tenants/${platformTenantId}/members`)).json() as {
      userId: string;
      superAdmin: boolean;
    }[];
    expect(members.find((m) => m.userId === userIds['sadmin'])?.superAdmin).toBe(true);
    expect(members.find((m) => m.userId === userIds['pmanager'])?.superAdmin).toBe(false);

    const mine = (await call('sadmin', 'GET', '/v1/me/tenants')).json() as {
      id: string;
      mySuperAdmin: boolean;
    }[];
    expect(mine.find((t) => t.id === platformTenantId)?.mySuperAdmin).toBe(true);
  });

  it('a super admin stays out of an org until it lets Circls in', async () => {
    const hits = (await call('sadmin', 'GET', '/v1/super-admin/tenants')).json() as { id: string }[];
    expect(hits.map((h) => h.id)).not.toContain(partnerTenantId);
    expect(errorCode(await call('sadmin', 'GET', `/v1/tenants/${partnerTenantId}`))).toBe('tenant_forbidden');
    const visit = await call('sadmin', 'POST', visitUrl());
    expect(errorCode(visit)).toBe('circls_support_not_granted');
    expect((await call('owner', 'GET', supportUrl())).json()).toEqual({ active: null });
  });

  it('the org lets Circls in for 3 hours, and its request shows in the picker', async () => {
    const before = Date.now();
    const res = await call('owner', 'POST', supportUrl(), { note: 'Set up our Diwali cup' });
    expect(res.statusCode).toBe(200);
    const active = res.json().active as { note: string; expiresAt: string };
    expect(active.note).toBe('Set up our Diwali cup');
    const left = new Date(active.expiresAt).getTime() - before;
    expect(left).toBeGreaterThan(2.9 * HOUR);
    expect(left).toBeLessThan(3.1 * HOUR);

    const hits = (
      await call('sadmin', 'GET', `/v1/super-admin/tenants?q=${encodeURIComponent(`solo sports ${SUFFIX}`)}`)
    ).json();
    expect(hits).toEqual([
      expect.objectContaining({ id: partnerTenantId, note: 'Set up our Diwali cup', expiresAt: active.expiresAt }),
    ]);
    // Never the Circls org itself.
    const visitCircls = await call('sadmin', 'POST', `/v1/super-admin/tenants/${platformTenantId}/visit`);
    expect(visitCircls.statusCode).toBe(404);
  });

  it('opening the org logs one visit per grant and names the helper on the Team page', async () => {
    const first = await call('sadmin', 'POST', visitUrl());
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: partnerTenantId, myRole: 'manager', superAdminVisit: true });
    expect(first.json().circlsSupportUntil).toEqual(expect.any(String));
    await call('sadmin', 'POST', visitUrl());

    const visits = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE tenant_id = ${partnerTenantId}::uuid
         AND actor_user_id = ${userIds['sadmin']}::uuid
         AND action = 'tenant.super_admin_visited'
    `);
    expect((visits as unknown as { n: number }[])[0]!.n).toBe(1);

    const status = (await call('owner', 'GET', supportUrl())).json() as {
      active: { helpers: { userId: string }[] };
    };
    expect(status.active.helpers.map((h) => h.userId)).toEqual([userIds['sadmin']]);
  });

  it('a super admin sets the org up like a Manager, without joining its team', async () => {
    const venue = await call('sadmin', 'POST', `/v1/tenants/${partnerTenantId}/venues`, { name: 'Court House' });
    expect(venue.statusCode).toBeLessThan(300);
    const event = await call('sadmin', 'POST', `/v1/tenants/${partnerTenantId}/events`, {
      addressJson: { line1: '5 MG Rd', city: 'Pune' },
      tzName: 'Asia/Kolkata',
      name: 'Planned Together Cup',
      startsAt: '2031-05-01T10:00:00.000Z',
      endsAt: '2031-05-01T12:00:00.000Z',
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    expect(event.statusCode).toBeLessThan(300);

    const members = (await call('owner', 'GET', `/v1/tenants/${partnerTenantId}/members`)).json() as {
      userId: string;
    }[];
    expect(members.map((m) => m.userId)).toEqual([userIds['owner']]);
  });

  it('a super admin cannot run the team, API keys, settings or Terms, or read Earnings', async () => {
    const invite = await call('sadmin', 'POST', `/v1/tenants/${partnerTenantId}/invitations`, {
      email: 'friend@x.com',
      role: 'staff',
    });
    expect(errorCode(invite)).toBe('forbidden_capability');
    const role = await call('sadmin', 'PATCH', `/v1/tenants/${partnerTenantId}/members/${userIds['owner']}`, {
      role: 'staff',
    });
    expect(errorCode(role)).toBe('forbidden_capability');
    const remove = await call('sadmin', 'DELETE', `/v1/tenants/${partnerTenantId}/members/${userIds['owner']}`);
    expect(errorCode(remove)).toBe('forbidden_capability');
    const key = await call('sadmin', 'POST', `/v1/tenants/${partnerTenantId}/api-keys`, {
      name: 'Mine',
      role: 'read',
    });
    expect(errorCode(key)).toBe('forbidden_capability');
    const terms = await call('sadmin', 'POST', `/v1/tenants/${partnerTenantId}/terms/accept`, {});
    expect(errorCode(terms)).toBe('forbidden_capability');
    const profile = await call('sadmin', 'PATCH', `/v1/tenants/${partnerTenantId}`, { description: 'Ours now' });
    expect(errorCode(profile)).toBe('forbidden_capability');
    const earnings = await call('sadmin', 'GET', `/v1/tenants/${partnerTenantId}/earnings`);
    expect(errorCode(earnings)).toBe('forbidden_capability');
    const waiver = await call('sadmin', 'GET', `/v1/tenants/${partnerTenantId}/commission-waiver`);
    expect(errorCode(waiver)).toBe('forbidden_capability');
    // Nor keep themselves in: only the org extends or ends Circls's access.
    expect(errorCode(await call('sadmin', 'POST', supportUrl(), {}))).toBe('forbidden_capability');
    expect(errorCode(await call('sadmin', 'DELETE', supportUrl()))).toBe('forbidden_capability');
  });

  it("the org's audit log marks the super admin's actions as Circls", async () => {
    const own = await call('owner', 'POST', `/v1/tenants/${partnerTenantId}/events`, {
      addressJson: { line1: '9 FC Rd', city: 'Pune' },
      tzName: 'Asia/Kolkata',
      name: "Owner's Own Meetup",
      startsAt: '2031-06-01T10:00:00.000Z',
      endsAt: '2031-06-01T12:00:00.000Z',
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    expect(own.statusCode).toBeLessThan(300);
    const page =(await call('owner', 'GET', `/v1/tenants/${partnerTenantId}/audit-log?limit=100`)).json() as {
      rows: { actorUserId: string | null; action: string; actorIsCircls: boolean }[];
    };
    const theirs = page.rows.filter((r) => r.actorUserId === userIds['sadmin']);
    expect(theirs.map((r) => r.action)).toContain('tenant.super_admin_visited');
    expect(theirs.length).toBeGreaterThan(1);
    expect(theirs.every((r) => r.actorIsCircls)).toBe(true);
    const owners = page.rows.filter((r) => r.actorUserId === userIds['owner']);
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.every((r) => !r.actorIsCircls)).toBe(true);
  });

  it("logs the super admin's changes that don't audit themselves, once each", async () => {
    const changeRows = async () =>
      (await db.execute<{ actor: string; after: { request: string; params: Record<string, string> } }>(sql`
        SELECT actor_user_id AS actor, after FROM audit_log
         WHERE tenant_id = ${partnerTenantId}::uuid AND action = 'tenant.super_admin_change'
         ORDER BY created_at
      `)) as unknown as { actor: string; after: { request: string; params: Record<string, string> } }[];
    const before = (await changeRows()).length;

    // Adding a venue writes no audit row of its own.
    const venue = await call('sadmin', 'POST', `/v1/tenants/${partnerTenantId}/venues`, { name: 'Side Court' });
    expect(venue.statusCode).toBeLessThan(300);
    const after = await changeRows();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toEqual({
      actor: userIds['sadmin'],
      after: { request: 'POST /v1/tenants/:tenantId/venues', params: { tenantId: partnerTenantId } },
    });

    // An event audits itself (event.created): no second row for it.
    const event = await call('sadmin', 'POST', `/v1/tenants/${partnerTenantId}/events`, {
      addressJson: { line1: '1 Brigade Rd', city: 'Pune' },
      tzName: 'Asia/Kolkata',
      name: 'Second Cup',
      startsAt: '2031-07-01T10:00:00.000Z',
      endsAt: '2031-07-01T12:00:00.000Z',
      tiers: [{ name: 'General', pricePaise: 0 }],
    });
    expect(event.statusCode).toBeLessThan(300);
    // A refused change, and the org's own Owner editing, leave none either.
    await call('sadmin', 'POST', `/v1/tenants/${partnerTenantId}/invitations`, { email: 'x@x.com', role: 'staff' });
    await call('owner', 'PATCH', `/v1/tenants/${partnerTenantId}`, { description: 'Our own words' });
    expect(await changeRows()).toHaveLength(before + 1);
  });

  it('asking again restarts the clock on the same grant', async () => {
    await db.execute(sql`
      UPDATE circls_support_grants SET expires_at = now() + interval '10 minutes'
       WHERE tenant_id = ${partnerTenantId}::uuid AND ended_at IS NULL
    `);
    const res = await call('owner', 'POST', supportUrl(), {});
    const active = res.json().active as { note: string; expiresAt: string };
    expect(new Date(active.expiresAt).getTime() - Date.now()).toBeGreaterThan(2.9 * HOUR);
    expect(active.note).toBe('Set up our Diwali cup');
    const grants = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM circls_support_grants WHERE tenant_id = ${partnerTenantId}::uuid
    `);
    expect((grants as unknown as { n: number }[])[0]!.n).toBe(1);
  });

  it('the org removes Circls, and the access ends at once', async () => {
    expect((await call('owner', 'DELETE', supportUrl())).statusCode).toBe(204);
    expect(errorCode(await call('sadmin', 'GET', `/v1/tenants/${partnerTenantId}`))).toBe('tenant_forbidden');
    expect(errorCode(await call('sadmin', 'POST', visitUrl()))).toBe('circls_support_not_granted');
    expect((await call('owner', 'GET', supportUrl())).json()).toEqual({ active: null });
    expect(errorCode(await call('owner', 'DELETE', supportUrl()))).toBe('circls_support_not_active');
  });

  it('the access runs out by itself', async () => {
    await call('owner', 'POST', supportUrl(), {});
    expect((await call('sadmin', 'GET', `/v1/tenants/${partnerTenantId}`)).statusCode).toBe(200);
    await db.execute(sql`
      UPDATE circls_support_grants SET expires_at = now() - interval '1 second'
       WHERE tenant_id = ${partnerTenantId}::uuid AND ended_at IS NULL
    `);
    expect(errorCode(await call('sadmin', 'GET', `/v1/tenants/${partnerTenantId}`))).toBe('tenant_forbidden');
    const hits = (await call('sadmin', 'GET', '/v1/super-admin/tenants')).json() as { id: string }[];
    expect(hits.map((h) => h.id)).not.toContain(partnerTenantId);
  });

  it('turning the switch off ends the access at once', async () => {
    await call('owner', 'POST', supportUrl(), {});
    expect((await call('sadmin', 'GET', `/v1/tenants/${partnerTenantId}`)).statusCode).toBe(200);
    const off = await setSuperAdmin('powner', userIds['sadmin']!, false);
    expect(off.json().superAdmin).toBe(false);
    const res = await call('sadmin', 'GET', `/v1/tenants/${partnerTenantId}`);
    expect(errorCode(res)).toBe('tenant_forbidden');
  });
});
