import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_evt_owner', email: 'evtowner@x.com', email_verified: true },
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

describe.skipIf(!runIntegration)('tenant event routes', () => {
  let app: FastifyInstance;
  let ownerId: string;
  let tenantId: string;
  const SUFFIX = Date.now();

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    ownerId = (me.json() as { id: string }).id;
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'EvtRoutes', slug: `evtroutes-${SUFFIX}` },
    });
    tenantId = (t.json() as { id: string }).id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenant_members where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${ownerId}`);
    await app.close();
    await closeDb();
  });

  it('creates an org-scoped event via POST /v1/tenants/:tenantId/events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: { line1: '5 MG Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Standalone Meetup',
        startsAt: '2030-05-01T10:00:00.000Z',
        endsAt: '2030-05-01T12:00:00.000Z',
        pricePaise: 0,
      },
    });
    expect(res.statusCode).toBe(200);
    const ev = res.json();
    expect(ev.venueId).toBeNull();
    expect(ev.tzName).toBe('Asia/Kolkata');
  });

  it('rejects a payload with both venueId and addressJson', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        venueId: '00000000-0000-0000-0000-000000000000',
        addressJson: { line1: 'x' },
        tzName: 'Asia/Kolkata',
        name: 'Both',
        startsAt: '2030-05-01T10:00:00.000Z',
        endsAt: '2030-05-01T12:00:00.000Z',
        pricePaise: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a payload with neither venueId nor addressJson', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        name: 'Neither',
        startsAt: '2030-05-01T10:00:00.000Z',
        endsAt: '2030-05-01T12:00:00.000Z',
        pricePaise: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a standalone payload with an empty address object', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: {
        addressJson: {},
        tzName: 'Asia/Kolkata',
        name: 'Empty Address',
        startsAt: '2030-05-01T10:00:00.000Z',
        endsAt: '2030-05-01T12:00:00.000Z',
        pricePaise: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists tenant events via GET /v1/tenants/:tenantId/events', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some((r: { venueId: string | null }) => r.venueId === null)).toBe(true);
  });
});
