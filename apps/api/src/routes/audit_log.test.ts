import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner:  { uid: 'fbuid_alowner',  email: 'alowner@x.com' },
      ownerB: { uid: 'fbuid_alownerb', email: 'alownerb@x.com' },
      other:  { uid: 'fbuid_alother',  email: 'alother@x.com' },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer }   = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

// ── helpers ──────────────────────────────────────────────────────────────────

/** Create a tenant via the route (creator becomes owner) and return its id. */
async function createTenant(app: FastifyInstance, token: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/tenants',
    headers: bearer(token),
    payload: { name: `Audit Co ${slug}`, slug },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { id: string }).id;
}

interface InsertAuditOpts {
  tenantId: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Offset in seconds from now (negative = past). */
  offsetSec?: number;
}

/** Directly insert an audit_log row, bypassing writeAudit so we can control timestamps. */
async function insertAudit(opts: InsertAuditOpts): Promise<string> {
  const offsetSec = opts.offsetSec ?? 0;
  const entityId = opts.entityId ?? crypto.randomUUID();
  const [row] = await db.execute<{ id: string }>(sql`
    INSERT INTO audit_log (tenant_id, actor_user_id, action, entity_type, entity_id, before, after, created_at)
    VALUES (
      ${opts.tenantId},
      ${opts.actorUserId ?? null},
      ${opts.action},
      ${opts.entityType},
      ${entityId},
      ${opts.before ? JSON.stringify(opts.before) : null}::jsonb,
      ${opts.after  ? JSON.stringify(opts.after)  : null}::jsonb,
      now() + make_interval(secs => ${offsetSec})
    )
    RETURNING id
  `);
  return (row as unknown as { id: string }).id;
}

interface AuditLogItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}
interface AuditLogPage {
  rows: AuditLogItem[];
  nextCursor: string | null;
}

// ── main suite ───────────────────────────────────────────────────────────────

describe.skipIf(!runIntegration)('GET /v1/tenants/:tenantId/audit-log', () => {
  let app: FastifyInstance;
  let tenantId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    tenantId = await createTenant(app, 'owner', `audit-main-${Date.now()}`);

    // Seed 6 entries with staggered timestamps (newest = offset 0, oldest = -500)
    // Offsets chosen so ordering is deterministic.
    await insertAudit({ tenantId, action: 'create', entityType: 'slot',    offsetSec: -500 });
    await insertAudit({ tenantId, action: 'update', entityType: 'slot',    offsetSec: -400 });
    await insertAudit({ tenantId, action: 'create', entityType: 'booking', offsetSec: -300 });
    await insertAudit({ tenantId, action: 'cancel', entityType: 'booking', offsetSec: -200 });
    await insertAudit({ tenantId, action: 'update', entityType: 'slot',    offsetSec: -100 });
    await insertAudit({ tenantId, action: 'delete', entityType: 'slot',    offsetSec:  -10 });
  });

  afterAll(async () => {
    await app.close();
    // closeDb deferred to the final suite.
  });

  async function fetchLog(tenantId: string, qs: string = '', token = 'owner'): Promise<AuditLogPage> {
    const url = `/v1/tenants/${tenantId}/audit-log${qs ? `?${qs}` : ''}`;
    const res = await app.inject({ method: 'GET', url, headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    return res.json() as AuditLogPage;
  }

  it('returns rows in DESC order (newest first)', async () => {
    const page = await fetchLog(tenantId);
    expect(page.rows.length).toBeGreaterThanOrEqual(6);
    const ts = page.rows.map((r) => r.createdAt);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]! <= ts[i - 1]!).toBe(true);
    }
  });

  it('each row has all required AuditLogItem fields', async () => {
    const page = await fetchLog(tenantId);
    const row = page.rows[0]!;
    expect(typeof row.id).toBe('string');
    expect(typeof row.action).toBe('string');
    expect(typeof row.entityType).toBe('string');
    expect(typeof row.createdAt).toBe('string');
    // actorUserId and actorName can be null
    expect('actorUserId' in row).toBe(true);
    expect('actorName' in row).toBe(true);
    expect('before' in row).toBe(true);
    expect('after' in row).toBe(true);
  });

  it('paginates: limit=2 returns 2 rows and a nextCursor', async () => {
    const page1 = await fetchLog(tenantId, 'limit=2');
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
  });

  it('cursor walks all pages in correct order without duplicates', async () => {
    const allIds: string[] = [];
    let cursor: string | null = null;

    do {
      const qs = cursor ? `limit=2&cursor=${encodeURIComponent(cursor)}` : 'limit=2';
      const page = await fetchLog(tenantId, qs);
      for (const row of page.rows) allIds.push(row.id);
      cursor = page.nextCursor;
    } while (cursor);

    expect(allIds.length).toBeGreaterThanOrEqual(6);
    // No duplicates
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('nextCursor is null when all rows fit in one page', async () => {
    const page = await fetchLog(tenantId, 'limit=100');
    expect(page.nextCursor).toBeNull();
  });

  it('filters by action', async () => {
    const page = await fetchLog(tenantId, 'action=create');
    expect(page.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of page.rows) expect(row.action).toBe('create');
  });

  it('filters by entityType', async () => {
    const page = await fetchLog(tenantId, 'entityType=booking');
    expect(page.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of page.rows) expect(row.entityType).toBe('booking');
  });

  it('filters by dateRange (from/to)', async () => {
    // The "create slot" row is at -500s, "update slot" at -400s.
    // Set from = now-600s, to = now-350s → should capture only the create-slot row.
    const fromTs = new Date(Date.now() - 600_000).toISOString();
    const toTs   = new Date(Date.now() - 350_000).toISOString();
    const page = await fetchLog(tenantId, `from=${encodeURIComponent(fromTs)}&to=${encodeURIComponent(toTs)}`);
    expect(page.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of page.rows) {
      expect(row.createdAt >= fromTs).toBe(true);
      expect(row.createdAt <  toTs).toBe(true);
    }
  });

  it('requires auth — 401 without bearer', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/tenants/${tenantId}/audit-log` });
    expect(res.statusCode).toBe(401);
  });

  it('non-member is forbidden — 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/audit-log`,
      headers: bearer('other'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects invalid limit (> 100) with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/audit-log?limit=999`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── tenant isolation ─────────────────────────────────────────────────────────

describe.skipIf(!runIntegration)('audit-log tenant isolation', () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    tenantAId = await createTenant(app, 'owner',  `audit-iso-a-${Date.now()}`);
    tenantBId = await createTenant(app, 'ownerB', `audit-iso-b-${Date.now()}`);

    // A gets 1 entry
    await insertAudit({ tenantId: tenantAId, action: 'create', entityType: 'slot' });
    // B gets 5 entries — must not bleed into A
    for (let i = 0; i < 5; i++) {
      await insertAudit({ tenantId: tenantBId, action: 'delete', entityType: 'slot' });
    }
  });

  afterAll(async () => {
    await app.close();
    // closeDb deferred to the final suite.
  });

  it("B's audit entries do not appear in A's response", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantAId}/audit-log`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const page = res.json() as AuditLogPage;
    // Only A's 1 row should appear
    expect(page.rows.length).toBe(1);
    for (const row of page.rows) {
      expect(row.action).toBe('create');
      expect(row.entityType).toBe('slot');
    }
  });
});

// ── empty state ──────────────────────────────────────────────────────────────

describe.skipIf(!runIntegration)('audit-log empty state', () => {
  let app: FastifyInstance;
  let tenantId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    tenantId = await createTenant(app, 'owner', `audit-empty-${Date.now()}`);
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('returns empty rows and null nextCursor for a fresh tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/audit-log`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const page = res.json() as AuditLogPage;
    expect(page.rows).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });
});
