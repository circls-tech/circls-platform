import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Firebase verifier mock: `owner` owns the tenant; `reader` is provisioned as a
// readonly tenant member to prove API-key management is gated behind the new
// `integration.api_keys.manage` capability (which readonly does NOT have).
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_ak_owner', email: 'ak_owner@x.com', email_verified: true },
      reader: { uid: 'fbuid_ak_reader', email: 'ak_reader@x.com', email_verified: true },
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

describe.skipIf(!runIntegration)('api-key management authz (H3)', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let readerUserId: string;
  const SUFFIX = Date.now();
  const slug = `ak-acme-${SUFFIX}`;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // Owner provisions their user row + a tenant they own (auto owner member).
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    expect(me.statusCode).toBe(200);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'API Key Acme', slug },
    });
    expect(created.statusCode).toBe(200);
    tenantId = (created.json() as { id: string }).id;

    // Provision the reader user row, then make them a *readonly* member of the
    // tenant. readonly lacks integration.api_keys.manage → must be 403.
    const readerMe = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('reader') });
    expect(readerMe.statusCode).toBe(200);
    readerUserId = (readerMe.json() as { id: string }).id;

    await db.execute(sql`
      INSERT INTO tenant_members (tenant_id, user_id, role)
      VALUES (${tenantId}::uuid, ${readerUserId}::uuid, 'readonly')
    `);
  });

  afterAll(async () => {
    if (tenantId) {
      await db.execute(sql`DELETE FROM api_keys WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM tenant_members WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}::uuid`);
    }
    await db.execute(sql`DELETE FROM users WHERE firebase_uid IN
      ('fbuid_ak_owner','fbuid_ak_reader')`);
    await app.close();
    await closeDb();
  });

  it('readonly member is forbidden from creating an API key (403 forbidden_capability)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/api-keys`,
      headers: bearer('reader'),
      payload: { name: 'sneaky', role: 'admin' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden_capability');
    expect(res.json().error.details.cap).toBe('integration.api_keys.manage');
  });

  it('readonly member is forbidden from listing API keys (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/api-keys`,
      headers: bearer('reader'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden_capability');
  });

  it('owner can create, list, and revoke API keys', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/api-keys`,
      headers: bearer('owner'),
      payload: { name: 'aggregator', role: 'write' },
    });
    expect(create.statusCode).toBe(200);
    const body = create.json() as { id: string; plaintext: string; prefix: string };
    expect(body.plaintext.startsWith('ck_')).toBe(true);
    const keyId = body.id;

    const list = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/api-keys`,
      headers: bearer('owner'),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { id: string }[]).some((k) => k.id === keyId)).toBe(true);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/api-keys/${keyId}`,
      headers: bearer('owner'),
    });
    expect(revoke.statusCode).toBe(204);
  });

  it('always audits key creation (H4): an api_key.created audit row exists', async () => {
    const before = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/api-keys`,
      headers: bearer('owner'),
      payload: { name: 'audited', role: 'read' },
    });
    expect(before.statusCode).toBe(200);
    const keyId = (before.json() as { id: string }).id;

    const rows = await db.execute<{ action: string }>(sql`
      SELECT action FROM audit_log
      WHERE tenant_id = ${tenantId}::uuid
        AND entity_type = 'api_key'
        AND entity_id = ${keyId}::uuid
        AND action = 'api_key.created'
    `);
    expect((rows as unknown as { action: string }[]).length).toBe(1);
  });
});
