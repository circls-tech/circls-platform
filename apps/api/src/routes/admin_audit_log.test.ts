import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      padmin: { uid: 'fbuid_padmin_al', email: 'padmin_al@x.com', email_verified: true },
      owner:  { uid: 'fbuid_powner_al', email: 'powner_al@x.com', email_verified: true },
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

interface AuditLogItem {
  id: string;
  tenantId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorContact: string | null;
  tenantName: string | null;
  entityName: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}
interface AuditLogPage { rows: AuditLogItem[]; nextCursor: string | null }

async function createTenantViaApi(app: FastifyInstance, token: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tenants',
    headers: bearer(token),
    payload: { name: `Audit Co ${slug}`, slug, country: 'India', acceptTerms: true },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { id: string }).id;
}

async function insertAudit(opts: {
  tenantId: string;
  action: string;
  entityType: string;
  entityId?: string;
  actorUserId?: string | null;
  offsetSec?: number;
}): Promise<string> {
  const offsetSec = opts.offsetSec ?? 0;
  const entityId = opts.entityId ?? crypto.randomUUID();
  const row = await db.execute<{ id: string }>(sql`
    INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, created_at)
    VALUES (
      ${opts.tenantId}::uuid,
      ${opts.actorUserId ?? null},
      ${opts.action},
      ${opts.entityType},
      ${entityId},
      now() + make_interval(secs => ${offsetSec})
    )
    RETURNING id
  `);
  return ((row as unknown as { id: string }[])[0]!).id;
}

describe.skipIf(!runIntegration)('GET /v1/admin/audit-log', () => {
  let app: FastifyInstance;
  let adminUserId: string;
  let tenantAId: string;
  let tenantBId: string;
  let platformTenantId: string;
  const SUFFIX = Date.now();
  const PLATFORM_SLUG = `circls-internal-test-al-${SUFFIX}`;
  let prevSlug: string | undefined;

  beforeAll(async () => {
    // Override the env slug so getPlatformTenantId() finds the seeded row.
    // Zod parses env at import time, so we mutate process.env directly here.
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('padmin') });
    expect(me.statusCode).toBe(200);
    adminUserId = (me.json() as { id: string }).id;

    // Insert a platform tenant whose slug matches the env override above
    const ptRows = await db.execute<{ id: string }>(sql`
      INSERT INTO tenants (name, slug, is_platform, status, subscription_status)
      VALUES ('Circls', ${PLATFORM_SLUG}, TRUE, 'active', 'trial')
      RETURNING id
    `);
    platformTenantId = ((ptRows as unknown as { id: string }[])[0]!).id;

    // Make padmin a manager of the platform tenant
    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${platformTenantId}::uuid, ${adminUserId}::uuid, 'manager')
    `);

    tenantAId = await createTenantViaApi(app, 'owner', `adm-al-a-${SUFFIX}`);
    tenantBId = await createTenantViaApi(app, 'owner', `adm-al-b-${SUFFIX}`);

    // Seed audit rows across both tenants
    await insertAudit({ tenantId: tenantAId, action: 'create', entityType: 'slot',    offsetSec: -500 });
    await insertAudit({ tenantId: tenantAId, action: 'update', entityType: 'slot',    offsetSec: -400 });
    await insertAudit({ tenantId: tenantBId, action: 'create', entityType: 'booking', offsetSec: -300 });
    await insertAudit({ tenantId: tenantBId, action: 'cancel', entityType: 'booking', offsetSec: -200 });
    await insertAudit({ tenantId: tenantAId, action: 'delete', entityType: 'slot',    actorUserId: adminUserId, offsetSec: -100 });
  });

  afterAll(async () => {
    // Clean up platform tenant membership + tenant row
    if (platformTenantId) {
      await db.execute(sql`DELETE FROM tenant_members WHERE tenant_id = ${platformTenantId}::uuid`);
      await db.execute(sql`DELETE FROM tenants WHERE id = ${platformTenantId}::uuid`);
    }
    // Restore the env slug override and flush the cache.
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug ?? 'circls-internal';
    __resetPlatformTenantCacheForTesting();
    await app.close();
    await closeDb();
  });

  async function fetchLog(qs: string = '', token = 'padmin'): Promise<AuditLogPage> {
    const url = `/v1/admin/audit-log${qs ? `?${qs}` : ''}`;
    const res = await app.inject({ method: 'GET', url, headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    return res.json() as AuditLogPage;
  }

  it('returns rows DESC, across tenants, with tenantId field present', async () => {
    const page = await fetchLog();
    expect(page.rows.length).toBeGreaterThanOrEqual(5);
    const ts = page.rows.map((r) => r.createdAt);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]! <= ts[i - 1]!).toBe(true);
    }
    // mix of tenants
    const tenantsSet = new Set(page.rows.map((r) => r.tenantId));
    expect(tenantsSet.size).toBeGreaterThanOrEqual(2);
  });

  it('filters by tenantId', async () => {
    const page = await fetchLog(`tenantId=${tenantAId}`);
    expect(page.rows.length).toBeGreaterThanOrEqual(3);
    for (const r of page.rows) expect(r.tenantId).toBe(tenantAId);
  });

  it('filters by entityType', async () => {
    const page = await fetchLog('entityType=booking');
    expect(page.rows.length).toBeGreaterThanOrEqual(2);
    for (const r of page.rows) expect(r.entityType).toBe('booking');
  });

  it('filters by action', async () => {
    const page = await fetchLog('action=create');
    expect(page.rows.length).toBeGreaterThanOrEqual(2);
    for (const r of page.rows) expect(r.action).toBe('create');
  });

  it('filters by actorUserId', async () => {
    const page = await fetchLog(`actorUserId=${adminUserId}`);
    expect(page.rows.length).toBeGreaterThanOrEqual(1);
    for (const r of page.rows) expect(r.actorUserId).toBe(adminUserId);
  });

  it('filters by since/until range', async () => {
    const since = new Date(Date.now() - 600_000).toISOString();
    const until = new Date(Date.now() - 350_000).toISOString();
    const page = await fetchLog(`since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`);
    expect(page.rows.length).toBeGreaterThanOrEqual(1);
    for (const r of page.rows) {
      expect(r.createdAt >= since).toBe(true);
      expect(r.createdAt <  until).toBe(true);
    }
  });

  it('paginates via cursor', async () => {
    const p1 = await fetchLog('limit=2');
    expect(p1.rows).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await fetchLog(`limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`);
    expect(p2.rows.length).toBeGreaterThan(0);
    const seen = new Set([...p1.rows, ...p2.rows].map((r) => r.id));
    expect(seen.size).toBe(p1.rows.length + p2.rows.length);
  });

  it('keeps combined search and filters tenant-scoped across pages', async () => {
    // The search and action deliberately match both tenants.
    const action = `audit.scope.${SUFFIX}`;
    const ids = [];
    for (const tenantId of [tenantAId, tenantBId]) {
      for (const offsetSec of [-30, -20, -10]) {
        ids.push(await insertAudit({ tenantId, action, entityType: 'slot', actorUserId: adminUserId, offsetSec }));
      }
    }
    try {
      const filters = new URLSearchParams({
        tenantId: tenantAId, q: `Audit Co adm-al-`, action,
        entityType: 'slot', actorUserId: adminUserId, limit: '2',
        since: new Date(Date.now() - 120_000).toISOString(),
        until: new Date(Date.now() + 60_000).toISOString(),
      });
      const first = await fetchLog(filters.toString());
      expect(first.rows).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      filters.set('cursor', first.nextCursor!);
      const second = await fetchLog(filters.toString());
      expect(second.rows).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const rows = [...first.rows, ...second.rows];
      expect(new Set(rows.map((row) => row.id)).size).toBe(3);
      expect(rows.every((row) => row.tenantId === tenantAId && row.action === action && row.actorUserId === adminUserId)).toBe(true);

      const differentTenantSearch = await fetchLog(new URLSearchParams({
        tenantId: tenantAId, q: `adm-al-b-${SUFFIX}`,
      }).toString());
      expect(differentTenantSearch.rows).toHaveLength(0);
    } finally {
      for (const id of ids) await db.execute(sql`DELETE FROM audit_log WHERE id = ${id}::uuid`);
    }
  });

  it('rejects bad limit', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log?limit=9999',
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('non-admin gets 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log',
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(403);
  });

  // tenantBId used → keep linter happy
  it('tenant B audit rows accessible via filter', async () => {
    const page = await fetchLog(`tenantId=${tenantBId}`);
    expect(page.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('finds rows by organisation name, so no UUID is needed', async () => {
    // The org is named "Audit Co adm-al-a-<suffix>" by the fixture helper.
    const page = await fetchLog(`q=${encodeURIComponent(`adm-al-a-${SUFFIX}`)}`);
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.tenantId === tenantAId)).toBe(true);
  });

  it('names the organisation on each row instead of only its id', async () => {
    const page = await fetchLog(`tenantId=${tenantAId}`);
    expect(page.rows[0]!.tenantName).toContain('Audit Co');
  });

  it('returns nothing when no organisation or person matches', async () => {
    const page = await fetchLog('q=zzz-no-such-thing-zzz');
    expect(page.rows).toHaveLength(0);
  });


  it('finds rows by the name of the event that was acted on', async () => {
    // Audit rows reference entities by uuid; searching should not require one.
    const evRows = (await db.execute(sql`
      insert into events (tenant_id, name, starts_at, ends_at, status, tz_name, address_json)
      values (${tenantAId}::uuid, 'Audit Searchable Gala', now() + interval '10 days',
              now() + interval '10 days 2 hours', 'draft', 'Asia/Kolkata', '{"city":"Pune"}'::jsonb)
      returning id
    `)) as unknown as Array<{ id: string }>;
    const eventId = evRows[0]!.id;
    await insertAudit({
      tenantId: tenantAId,
      action: 'event.updated',
      entityType: 'event',
      entityId: eventId,
    });

    const page = await fetchLog('q=searchable%20gala');
    expect(page.rows.some((r) => r.entityId === eventId)).toBe(true);
    // And the row names it rather than showing a uuid fragment.
    expect(page.rows.find((r) => r.entityId === eventId)!.entityName).toBe(
      'Audit Searchable Gala',
    );

    await db.execute(sql`delete from audit_log where entity_id = ${eventId}::uuid`);
    await db.execute(sql`delete from events where id = ${eventId}::uuid`);
  });

  it('leaves entityName null for things that have no name', async () => {
    const page = await fetchLog(`tenantId=${tenantAId}&entityType=slot`);
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.entityName === null)).toBe(true);
  });
});
