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

  it('a super admin finds partner orgs, never the Circls one', async () => {
    const hits = (await call('sadmin', 'GET', `/v1/super-admin/tenants?q=${encodeURIComponent(`solo sports ${SUFFIX}`)}`)).json() as {
      id: string;
    }[];
    expect(hits.map((h) => h.id)).toEqual([partnerTenantId]);
    const circls = (await call('sadmin', 'GET', `/v1/super-admin/tenants?q=${PLATFORM_SLUG}`)).json() as unknown[];
    expect(circls).toEqual([]);
    const visitCircls = await call('sadmin', 'POST', `/v1/super-admin/tenants/${platformTenantId}/visit`);
    expect(visitCircls.statusCode).toBe(404);
  });

  it('opening an org logs one visit on its audit log, not one per reload', async () => {
    const first = await call('sadmin', 'POST', `/v1/super-admin/tenants/${partnerTenantId}/visit`);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: partnerTenantId, myRole: 'manager', superAdminVisit: true });
    await call('sadmin', 'POST', `/v1/super-admin/tenants/${partnerTenantId}/visit`);

    const visits = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE tenant_id = ${partnerTenantId}::uuid
         AND actor_user_id = ${userIds['sadmin']}::uuid
         AND action = 'tenant.super_admin_visited'
    `);
    expect((visits as unknown as { n: number }[])[0]!.n).toBe(1);
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

  it('a super admin cannot run the team, the API keys or the Terms', async () => {
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
    expect(errorCode(terms)).toBe('super_admin_forbidden');
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

    // Editing the org profile writes no audit row of its own.
    const profile = await call('sadmin', 'PATCH', `/v1/tenants/${partnerTenantId}`, {
      description: 'Set up with help from Circls',
    });
    expect(profile.statusCode).toBe(200);
    const after = await changeRows();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toEqual({
      actor: userIds['sadmin'],
      after: { request: 'PATCH /v1/tenants/:id', params: { id: partnerTenantId } },
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

  it('turning the switch off ends the access at once', async () => {
    const off = await setSuperAdmin('powner', userIds['sadmin']!, false);
    expect(off.json().superAdmin).toBe(false);
    const res = await call('sadmin', 'GET', `/v1/tenants/${partnerTenantId}`);
    expect(errorCode(res)).toBe('tenant_forbidden');
  });
});
