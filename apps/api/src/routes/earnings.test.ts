import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner:    { uid: 'fbuid_earnown',  email: 'earnown@x.com',  email_verified: true },
      staff:    { uid: 'fbuid_earnstf',  email: 'earnstf@x.com',  email_verified: true },
      readonly: { uid: 'fbuid_earnro',   email: 'earnro@x.com',   email_verified: true },
      outsider: { uid: 'fbuid_earnout',  email: 'earnout@x.com',  email_verified: true },
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

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-02-01T00:00:00.000Z';

/**
 * The authorization boundary on partner financial data, and the window
 * validation that keeps a page load from asking for an unbounded scan.
 *
 * Worth testing at the route rather than only the service: the capability
 * check is the only thing standing between a Staff member — or another
 * organisation entirely — and what a partner is paid.
 */
describe.skipIf(!runIntegration)('GET /v1/tenants/:tenantId/earnings', () => {
  let app: FastifyInstance;
  let tenantId: string;

  /** Sign a user in once so their `users` row exists, and return its id. */
  async function ensureUser(token: string, email: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    const [row] = (await db.execute<Record<string, unknown>>(
      sql`select id from users where email = ${email} limit 1`,
    )) as unknown as Record<string, unknown>[];
    return row!['id'] as string;
  }

  async function addMember(userId: string, role: string): Promise<void> {
    await db.execute(sql`
      insert into tenant_members (tenant_id, user_id, role)
      values (${tenantId}::uuid, ${userId}::uuid, ${role})
      on conflict (tenant_id, user_id) do update set role = ${role}
    `);
  }

  function get(qs: string, token = 'owner') {
    return app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/earnings${qs}`,
      headers: bearer(token),
    });
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const slug = `earn-route-${Date.now()}`;
    const created = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: `Earnings Co ${slug}`, slug, country: 'India', acceptTerms: true },
    });
    expect(created.statusCode).toBe(200);
    tenantId = (created.json() as { id: string }).id;

    await addMember(await ensureUser('staff', 'earnstf@x.com'), 'staff');
    await addMember(await ensureUser('readonly', 'earnro@x.com'), 'readonly');
    await ensureUser('outsider', 'earnout@x.com'); // deliberately not a member
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  // ── Authorization ──────────────────────────────────────────────────────────

  it('lets an Owner read the organisation s earnings', async () => {
    const res = await get(`?from=${FROM}&to=${TO}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['from']).toBe(FROM);
    expect(body['to']).toBe(TO);
    expect(Array.isArray(body['total'])).toBe(true);
    expect(Array.isArray(body['byStream'])).toBe(true);
    expect(Array.isArray(body['items'])).toBe(true);
    expect(Array.isArray(body['desk'])).toBe(true);
  });

  it('lets a Read-only member read them — the accountant s role', async () => {
    const res = await get(`?from=${FROM}&to=${TO}`, 'readonly');
    expect(res.statusCode).toBe(200);
  });

  it('refuses a Staff member: they run the desk, not the books', async () => {
    const res = await get(`?from=${FROM}&to=${TO}`, 'staff');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden_capability' } });
  });

  it('refuses someone who is not a member at all', async () => {
    const res = await get(`?from=${FROM}&to=${TO}`, 'outsider');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'tenant_forbidden' } });
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/earnings?from=${FROM}&to=${TO}`,
    });
    expect(res.statusCode).toBe(401);
  });

  // ── Window validation ──────────────────────────────────────────────────────

  it('requires both bounds', async () => {
    expect((await get(`?from=${FROM}`)).statusCode).toBe(400);
    expect((await get(`?to=${TO}`)).statusCode).toBe(400);
    expect((await get('')).statusCode).toBe(400);
  });

  it('rejects a non-ISO date', async () => {
    expect((await get(`?from=2026-01-01&to=${TO}`)).statusCode).toBe(400);
  });

  it('rejects a window that ends before it starts, or is empty', async () => {
    expect((await get(`?from=${TO}&to=${FROM}`)).statusCode).toBe(400);
    expect((await get(`?from=${FROM}&to=${FROM}`)).statusCode).toBe(400);
  });

  it('rejects a window wider than the 400-day cap', async () => {
    const tooFar = new Date(Date.parse(FROM) + 401 * 86_400_000).toISOString();
    expect((await get(`?from=${FROM}&to=${tooFar}`)).statusCode).toBe(400);

    const justInside = new Date(Date.parse(FROM) + 399 * 86_400_000).toISOString();
    expect((await get(`?from=${FROM}&to=${justInside}`)).statusCode).toBe(200);
  });

  // ── The design guarantee ───────────────────────────────────────────────────

  it('never returns a gross, commission or fee figure', async () => {
    // Net-only is enforced by the API, not merely hidden by the portal, so a
    // partner reading the response in devtools still cannot derive the
    // commission rate. See earnings_service.
    const res = await get(`?from=${FROM}&to=${TO}`);
    const body = JSON.stringify(res.json());
    for (const forbidden of ['grossPaise', 'commissionPaise', 'refundsPaise', 'feePaise']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
