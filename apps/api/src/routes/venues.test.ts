import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_vowner', email: 'vowner@x.com', email_verified: true },
      other: { uid: 'fbuid_vother', email: 'vother@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');
const { sql } = await import('drizzle-orm');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('venues', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Venue Co', slug: `vco-${Date.now()}`, country: 'India', acceptTerms: true },
    });
    tenantId = t.json().id;
  });
  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('owner creates a venue under their tenant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Court House', lat: 21.1458, lng: 79.0882 },
    });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    venueId = v.id;
    expect(v.tenantId).toBe(tenantId);
    expect(v.tzName).toBe('Asia/Kolkata');
    // New venues await Circls review before going live (subproject B).
    expect(v.status).toBe('pending_review');
  });

  it('blocks a non-member from creating or reading venues', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('other'),
      payload: { name: 'Sneaky' },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error.code).toBe('tenant_forbidden');

    const read = await app.inject({ method: 'GET', url: `/v1/venues/${venueId}`, headers: bearer('other') });
    expect(read.statusCode).toBe(403);
  });

  it('lists + fetches venues for members', async () => {
    const list = await app.inject({ method: 'GET', url: `/v1/tenants/${tenantId}/venues`, headers: bearer('owner') });
    expect(list.json().some((v: { id: string }) => v.id === venueId)).toBe(true);
    const get = await app.inject({ method: 'GET', url: `/v1/venues/${venueId}`, headers: bearer('owner') });
    expect(get.statusCode).toBe(200);
    expect(get.json().id).toBe(venueId);
  });

  it('soft-deletes via status patch', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/venues/${venueId}`,
      headers: bearer('owner'),
      payload: { status: 'suspended' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('suspended');
  });

  it('creates a venue with tags and returns them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Tagged Venue', tags: ['indoor', 'premium', 'rooftop'] },
    });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v.tags).toEqual(['indoor', 'premium', 'rooftop']);
  });

  it('creates a venue without tags and returns empty array', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'No Tag Venue' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toEqual([]);
  });

  describe('closing and reopening', () => {
    async function venueIn(status: 'active' | 'pending_review' | 'rejected'): Promise<string> {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/venues`,
        headers: bearer('owner'),
        payload: { name: `Close test ${status} ${Date.now()}` },
      });
      const id = res.json().id as string;
      // Review is admin-only; set the starting state directly.
      await db.execute(sql`update venues set status = ${status} where id = ${id}::uuid`);
      return id;
    }
    const post = (id: string, action: 'close' | 'reopen', who = 'owner') =>
      app.inject({ method: 'POST', url: `/v1/venues/${id}/${action}`, headers: bearer(who) });

    it('closes a live venue and reopens it straight back to live', async () => {
      const id = await venueIn('active');
      const closed = await post(id, 'close');
      expect(closed.statusCode).toBe(200);
      expect(closed.json().status).toBe('suspended');

      const reopened = await post(id, 'reopen');
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json().status).toBe('active');
      expect(reopened.json().statusBeforeClose).toBeNull();
    });

    // Reopening must never be a way round Circls review.
    it('returns a venue closed while in review to review, not to live', async () => {
      const id = await venueIn('pending_review');
      await post(id, 'close');
      expect((await post(id, 'reopen')).json().status).toBe('pending_review');
    });

    it('keeps a rejected venue rejected through a close and reopen', async () => {
      const id = await venueIn('rejected');
      await post(id, 'close');
      expect((await post(id, 'reopen')).json().status).toBe('rejected');
    });

    it('sends a venue closed before this was recorded back to review', async () => {
      const id = await venueIn('active');
      await db.execute(
        sql`update venues set status = 'suspended', status_before_close = null where id = ${id}::uuid`,
      );
      expect((await post(id, 'reopen')).json().status).toBe('pending_review');
    });

    // A retry or double click must not overwrite the remembered status with
    // 'suspended', which would strand the venue closed.
    it('treats closing a closed venue as a no-op', async () => {
      const id = await venueIn('active');
      await post(id, 'close');
      const again = await post(id, 'close');
      expect(again.statusCode).toBe(200);
      expect(again.json().statusBeforeClose).toBe('active');
      expect((await post(id, 'reopen')).json().status).toBe('active');
    });

    it('refuses to reopen a venue that is not closed', async () => {
      const id = await venueIn('active');
      const res = await post(id, 'reopen');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('venue_not_closed');
    });

    it('records both moves in the audit log', async () => {
      const id = await venueIn('active');
      await post(id, 'close');
      await post(id, 'reopen');
      const rows = (await db.execute(sql`
        select action, before, after from audit_log
         where entity_id = ${id}::uuid and action in ('venue.closed', 'venue.reopened')
         order by created_at
      `)) as unknown as { action: string; before: { status: string }; after: { status: string } }[];
      expect(rows.map((r) => r.action)).toEqual(['venue.closed', 'venue.reopened']);
      expect(rows[0]!.before.status).toBe('active');
      expect(rows[1]!.after.status).toBe('active');
    });

    it("won't let a partner outside the organisation close its venue", async () => {
      const id = await venueIn('active');
      expect((await post(id, 'close', 'other')).statusCode).toBe(403);
    });

    // The hole this closes: PATCH wrote `status` straight to the row, so a
    // partner could publish a venue Circls had never approved.
    it('no longer lets a PATCH publish a venue that is awaiting review', async () => {
      const id = await venueIn('pending_review');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/venues/${id}`,
        headers: bearer('owner'),
        payload: { status: 'active' },
      });
      expect(res.statusCode).toBe(409);
      const [row] = (await db.execute(
        sql`select status from venues where id = ${id}::uuid`,
      )) as unknown as { status: string }[];
      expect(row!.status).toBe('pending_review');
    });

    it('no longer lets a PATCH overturn a rejection', async () => {
      const id = await venueIn('rejected');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/venues/${id}`,
        headers: bearer('owner'),
        payload: { status: 'active' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('still accepts a PATCH that renames and closes in one go', async () => {
      const id = await venueIn('active');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/venues/${id}`,
        headers: bearer('owner'),
        payload: { status: 'suspended', name: 'Renamed While Closing' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('suspended');
      expect(res.json().name).toBe('Renamed While Closing');
    });
  });
});
