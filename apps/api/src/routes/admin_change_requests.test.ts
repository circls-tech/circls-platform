import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      padmin: { uid: 'fbuid_padmin_cr', email: 'padmin_cr@x.com', email_verified: true },
      owner: { uid: 'fbuid_powner_cr', email: 'powner_cr@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { __resetPlatformTenantCacheForTesting } = await import('../lib/authz/platform_tenant.js');
const { createEvent } = await import('../services/events_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('admin change requests routes', () => {
  let app: FastifyInstance;
  let adminUserId: string;
  let ownerUserId: string;
  let tenantId: string;
  let platformTenantId: string;
  let eventId: string;
  const SUFFIX = Date.now();
  const PLATFORM_SLUG = `circls-internal-test-cr-${SUFFIX}`;
  let prevSlug: string | undefined;

  beforeAll(async () => {
    prevSlug = process.env['CIRCLS_INTERNAL_TENANT_SLUG'];
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = PLATFORM_SLUG;
    __resetPlatformTenantCacheForTesting();

    app = await buildServer();
    await app.ready();

    const adminMe = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('padmin') });
    expect(adminMe.statusCode).toBe(200);
    adminUserId = (adminMe.json() as { id: string }).id;

    const ownerMe = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    expect(ownerMe.statusCode).toBe(200);
    ownerUserId = (ownerMe.json() as { id: string }).id;

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

    const created = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: `CR Routes Co ${SUFFIX}`, slug: `cr-routes-${SUFFIX}`, country: 'India', acceptTerms: true },
    });
    expect(created.statusCode).toBe(200);
    tenantId = (created.json() as { id: string }).id;

    // A published standalone event to request changes against.
    const ev = await createEvent(
      { tenantId, actorUserId: ownerUserId },
      {
        tenantId,
        addressJson: { line1: '1 CR Road', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'CR Routes Event',
        startsAt: new Date('2031-05-01T10:00:00Z'),
        endsAt: new Date('2031-05-01T12:00:00Z'),
        tiers: [{ name: 'General', pricePaise: 5000 }],
      },
    );
    eventId = ev.id;
    await db.execute(sql`UPDATE events SET status = 'published' WHERE id = ${eventId}::uuid`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}::uuid`);
    await db.execute(sql`DELETE FROM events WHERE tenant_id = ${tenantId}::uuid`);
    await db.execute(sql`DELETE FROM tenant_members WHERE tenant_id IN (${platformTenantId}::uuid, ${tenantId}::uuid)`);
    await db.execute(sql`DELETE FROM tenants WHERE id IN (${platformTenantId}::uuid, ${tenantId}::uuid)`);
    process.env['CIRCLS_INTERNAL_TENANT_SLUG'] = prevSlug ?? 'circls-internal';
    __resetPlatformTenantCacheForTesting();
    await app.close();
    await closeDb();
  });

  let requestId: string;

  it('partner submits a change request; empty and duplicate submissions are rejected', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events/${eventId}/change-requests`,
      headers: bearer('owner'),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events/${eventId}/change-requests`,
      headers: bearer('owner'),
      payload: { name: 'Renamed Via Route' },
    });
    expect(res.statusCode).toBe(200);
    requestId = (res.json() as { id: string }).id;

    const dupe = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events/${eventId}/change-requests`,
      headers: bearer('owner'),
      payload: { name: 'Second' },
    });
    expect(dupe.statusCode).toBe(409);
    expect((dupe.json() as { error: { code: string } }).error.code).toBe('change_request_pending');

    const list = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/events/${eventId}/change-requests`,
      headers: bearer('owner'),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('admin endpoints require auth and the review capability', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/admin/change-requests' });
    expect(anon.statusCode).toBe(401);

    const partner = await app.inject({
      method: 'GET',
      url: '/v1/admin/change-requests',
      headers: bearer('owner'),
    });
    // The partner owner is not a member of the platform tenant.
    expect([403, 404]).toContain(partner.statusCode);
  });

  it('admin sees the queue and detail', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/change-requests',
      headers: bearer('padmin'),
    });
    expect(list.statusCode).toBe(200);
    const rows = (list.json() as { rows: { id: string; eventName: string; fields: string[] }[] }).rows;
    const mine = rows.find((r) => r.id === requestId);
    expect(mine).toBeDefined();
    expect(mine!.eventName).toBe('CR Routes Event');
    expect(mine!.fields).toEqual(['name']);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/admin/change-requests/${requestId}`,
      headers: bearer('padmin'),
    });
    expect(detail.statusCode).toBe(200);
    const d = detail.json() as { patch: { name: string }; event: { name: string } };
    expect(d.patch.name).toBe('Renamed Via Route');
    expect(d.event.name).toBe('CR Routes Event');
  });

  it('rejects an over-long reject reason', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/change-requests/${requestId}/reject`,
      headers: bearer('padmin'),
      payload: { reason: 'x'.repeat(501) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('admin approves; the event is renamed and the partner cannot withdraw anymore', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/change-requests/${requestId}/approve`,
      headers: bearer('padmin'),
    });
    expect(res.statusCode).toBe(200);

    const ev = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/events/${eventId}`,
      headers: bearer('owner'),
    });
    expect(ev.statusCode).toBe(200);
    expect((ev.json() as { name: string }).name).toBe('Renamed Via Route');

    const withdraw = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events/${eventId}/change-requests/${requestId}/withdraw`,
      headers: bearer('owner'),
    });
    expect(withdraw.statusCode).toBe(409);
  });
});
