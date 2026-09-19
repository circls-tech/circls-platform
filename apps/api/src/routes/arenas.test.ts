import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_aowner', email: 'aowner@x.com', email_verified: true },
      other: { uid: 'fbuid_aother', email: 'aother@x.com', email_verified: true },
      // separate user for arena-read tenant-isolation tests
      arOwner: { uid: 'fbuid_arowner', email: 'arowner@x.com', email_verified: true },
      arOther: { uid: 'fbuid_arother', email: 'arother@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { sql } = await import('drizzle-orm');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('arenas + schedule', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let arenaId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Arena Co', slug: `aco-${Date.now()}`, country: 'India', acceptTerms: true },
    });
    tenantId = t.json().id;
    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Hall' },
    });
    venueId = v.json().id;
  });
  afterAll(async () => {
    await app.close();
    // closeDb deferred to the GET /v1/arenas/:arenaId suite below
  });

  it('creates an arena under a venue', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Court 1', sport: 'badminton', slotDurationMin: 60 },
    });
    expect(res.statusCode).toBe(200);
    arenaId = res.json().id;
    expect(res.json().venueId).toBe(venueId);
  });

  it('blocks a non-member from creating arenas', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('other'),
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates arena with tags only → sport inferred from tags', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Cricket Net', tags: ['nets', 'outdoor'] },
    });
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.tags).toEqual(['nets', 'outdoor']);
    expect(a.sport).toBe('cricket');
  });

  it('creates arena with explicit sport + tags → explicit sport wins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Tennis Court A', sport: 'tennis', tags: ['nets', 'indoor'] },
    });
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.sport).toBe('tennis');
    expect(a.tags).toEqual(['nets', 'indoor']);
  });

  it('creates arena with neither sport nor tags → sport null, tags empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Mystery Court' },
    });
    expect(res.statusCode).toBe(200);
    const a = res.json();
    expect(a.sport).toBeNull();
    expect(a.tags).toEqual([]);
  });

  it('sets and reads the weekly schedule', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/arenas/${arenaId}/schedule`,
      headers: bearer('owner'),
      payload: {
        rows: [
          { dayOfWeek: 6, startTime: '06:00', endTime: '22:00', slotDurationMin: 60 },
          { dayOfWeek: 0, startTime: '08:00', endTime: '20:00' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().length).toBe(2);
    const get = await app.inject({ method: 'GET', url: `/v1/arenas/${arenaId}/schedule`, headers: bearer('owner') });
    expect(get.json().length).toBe(2);
  });

  describe('closing and reopening an arena', () => {
    async function arenaIn(status: 'active' | 'pending_review' | 'rejected'): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/venues/${venueId}/arenas`,
        headers: bearer('owner'),
        payload: { name: `Close test ${status} ${Date.now()}`, slotDurationMin: 60 },
      });
      const id = res.json().id as string;
      // Review is admin-only; set the starting state directly.
      await db.execute(sql`update arenas set status = ${status} where id = ${id}::uuid`);
      return id;
    }
    const post = (id: string, action: 'close' | 'reopen', who = 'owner') =>
      app.inject({ method: 'POST', url: `/v1/arenas/${id}/${action}`, headers: bearer(who) });

    it('closes a live arena and reopens it straight back to live', async () => {
      const id = await arenaIn('active');
      const closed = await post(id, 'close');
      expect(closed.statusCode).toBe(200);
      expect(closed.json().status).toBe('suspended');
      const reopened = await post(id, 'reopen');
      expect(reopened.json().status).toBe('active');
      expect(reopened.json().statusBeforeClose).toBeNull();
    });

    // Reopening must never be a way round Circls review.
    it('returns an arena closed while in review to review, and a rejected one to rejected', async () => {
      const pending = await arenaIn('pending_review');
      await post(pending, 'close');
      expect((await post(pending, 'reopen')).json().status).toBe('pending_review');

      const rejected = await arenaIn('rejected');
      await post(rejected, 'close');
      expect((await post(rejected, 'reopen')).json().status).toBe('rejected');
    });

    it('treats closing a closed arena as a no-op, keeping what to restore', async () => {
      const id = await arenaIn('active');
      await post(id, 'close');
      const again = await post(id, 'close');
      expect(again.statusCode).toBe(200);
      expect(again.json().statusBeforeClose).toBe('active');
    });

    it('refuses to reopen an arena that is not closed', async () => {
      const id = await arenaIn('active');
      const res = await post(id, 'reopen');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('arena_not_closed');
    });

    it("won't let someone outside the organisation close its arena", async () => {
      const id = await arenaIn('active');
      expect((await post(id, 'close', 'other')).statusCode).toBe(403);
    });

    it('records both moves in the audit log', async () => {
      const id = await arenaIn('active');
      await post(id, 'close');
      await post(id, 'reopen');
      const rows = (await db.execute(sql`
        select action from audit_log
         where entity_id = ${id}::uuid and action in ('arena.closed', 'arena.reopened')
         order by created_at
      `)) as unknown as { action: string }[];
      expect(rows.map((r) => r.action)).toEqual(['arena.closed', 'arena.reopened']);
    });

    // Consumer checkout used to check only the venue, so a slot on a closed
    // arena could still be bought from a cart built before it closed.
    it("stops a consumer checking out a closed arena's slot", async () => {
      await db.execute(sql`update venues set status = 'active' where id = ${venueId}::uuid`);
      const id = await arenaIn('active');
      const [slot] = (await db.execute(sql`
        insert into slots (tenant_id, arena_id, time_range, price_paise, status)
        values (${tenantId}::uuid, ${id}::uuid,
                tstzrange(now() + interval '3 days', now() + interval '3 days 1 hour', '[)'),
                10000, 'open')
        returning id
      `)) as unknown as { id: string }[];
      await post(id, 'close');

      const res = await app.inject({
        method: 'POST',
        url: '/v1/consumer/bookings',
        headers: bearer('owner'),
        payload: { slotIds: [slot!.id], customerName: 'Late Cart', customerContact: '+919800000002' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('arena_not_found');
    });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/arenas/:arenaId — tenant-scoped read endpoint
// ---------------------------------------------------------------------------
describe.skipIf(!runIntegration)('GET /v1/arenas/:arenaId', () => {
  let app: FastifyInstance;
  let venueId: string;
  let arenaId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // Seed: arOwner creates tenant → venue → arena
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('arOwner'),
      payload: { name: 'Arena Read Co', slug: `arco-${Date.now()}`, country: 'India', acceptTerms: true },
    });
    const tenantId: string = t.json().id;

    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('arOwner'),
      payload: { name: 'Read Hall' },
    });
    venueId = v.json().id;

    const a = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('arOwner'),
      payload: { name: 'Main Court', sport: 'tennis', slotDurationMin: 60 },
    });
    arenaId = a.json().id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('returns 200 with arena id, name, and venueId for a tenant member', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}`,
      headers: bearer('arOwner'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(arenaId);
    expect(body.name).toBe('Main Court');
    expect(body.venueId).toBe(venueId);
  });

  it('returns 403 for a user who is not a member of the arena tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}`,
      headers: bearer('arOther'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 with arena_not_found for an unknown arenaId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/arenas/00000000-0000-0000-0000-000000000099',
      headers: bearer('arOwner'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('arena_not_found');
  });
});
