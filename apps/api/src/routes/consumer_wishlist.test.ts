import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Consumer wishlist / likes (GET|PUT|DELETE /v1/consumer/me/wishlist…).
// Integration-gated (needs Postgres); mirrors consumer_profile.test.ts.
vi.mock('../lib/firebase_admin.js', () => ({
  // Account deletion tears down the Firebase user last; nothing to do here.
  deleteFirebaseUser: vi.fn(async () => {}),
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      wisher: { uid: 'fbuid_wishlist_a', phone_number: '+919999900001' },
      other: { uid: 'fbuid_wishlist_b', phone_number: '+919999900002' },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { eq, sql } = await import('drizzle-orm');
const { closeDb, db } = await import('../db/client.js');
const { events, memberships, tenants, venues } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('consumer wishlist', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let eventId: string;
  let membershipId: string;
  let draftEventId: string;

  const dropUsers = () =>
    db.execute(sql`delete from users where firebase_uid in ('fbuid_wishlist_a', 'fbuid_wishlist_b')`);

  beforeAll(async () => {
    await dropUsers();
    app = await buildServer();
    await app.ready();

    const [t] = await db
      .insert(tenants)
      .values({ name: 'Wishlist Org', slug: `wishlist-org-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'Wishlist Venue', tzName: 'Asia/Kolkata', status: 'active' })
      .returning();
    venueId = v!.id;
    const [e] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Wishlist Event',
        startsAt: new Date('2031-01-01T10:00:00Z'),
        endsAt: new Date('2031-01-01T12:00:00Z'),
        pricePaise: 0,
        status: 'published',
      })
      .returning();
    eventId = e!.id;
    const [d] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Wishlist Draft Event',
        startsAt: new Date('2031-01-02T10:00:00Z'),
        endsAt: new Date('2031-01-02T12:00:00Z'),
        pricePaise: 0,
        status: 'draft',
      })
      .returning();
    draftEventId = d!.id;
    const [m] = await db
      .insert(memberships)
      .values({ tenantId, venueId: null, name: 'Wishlist Pass', durationDays: 30, pricePaise: 1000, status: 'active' })
      .returning();
    membershipId = m!.id;
  });

  afterAll(async () => {
    // wishlist_items cascades from users.
    await dropUsers();
    await db.execute(sql`delete from memberships where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await app.close();
    await closeDb();
  });

  it('requires a signed-in consumer', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist' });
    expect(res.statusCode).toBe(401);
    const put = await app.inject({ method: 'PUT', url: `/v1/consumer/me/wishlist/event/${eventId}` });
    expect(put.statusCode).toBe(401);
  });

  it('starts empty', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist', headers: bearer('wisher') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [], memberships: [], venues: [] });
    const ids = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist/ids', headers: bearer('wisher') });
    expect(ids.json()).toEqual({ events: [], memberships: [], venues: [] });
  });

  it('likes an event, a membership and a venue; the read returns them in card shape', async () => {
    for (const [type, id] of [['event', eventId], ['membership', membershipId], ['venue', venueId]] as const) {
      const res = await app.inject({ method: 'PUT', url: `/v1/consumer/me/wishlist/${type}/${id}`, headers: bearer('wisher') });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ liked: true });
    }

    const ids = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist/ids', headers: bearer('wisher') });
    expect(ids.json()).toEqual({ events: [eventId], memberships: [membershipId], venues: [venueId] });

    const res = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist', headers: bearer('wisher') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].id).toBe(eventId);
    expect(body.events[0].name).toBe('Wishlist Event');
    expect(body.events[0].locationName).toBe('Wishlist Venue');
    expect(typeof body.events[0].likedAt).toBe('string');
    // Public projection: the partner-only columns never ride along.
    expect(body.events[0]).not.toHaveProperty('postBookingRedirect');
    expect(body.events[0]).not.toHaveProperty('partnerCommissionBps');
    expect(body.memberships.map((m: { id: string }) => m.id)).toEqual([membershipId]);
    expect(body.memberships[0].scopeName).toBe('Wishlist Org');
    expect(body.venues.map((v: { id: string }) => v.id)).toEqual([venueId]);
    expect(body.venues[0].brand.name).toBe('Wishlist Org');
  });

  it('liking twice is a no-op and keeps the original likedAt', async () => {
    const before = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist', headers: bearer('wisher') });
    const res = await app.inject({ method: 'PUT', url: `/v1/consumer/me/wishlist/event/${eventId}`, headers: bearer('wisher') });
    expect(res.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist', headers: bearer('wisher') });
    expect(after.json().events).toHaveLength(1);
    expect(after.json().events[0].likedAt).toBe(before.json().events[0].likedAt);
  });

  it('is private to the signed-in consumer', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist/ids', headers: bearer('other') });
    expect(res.json()).toEqual({ events: [], memberships: [], venues: [] });
  });

  it('refuses to like a listing the catalogue does not show (404, no probing)', async () => {
    const draft = await app.inject({ method: 'PUT', url: `/v1/consumer/me/wishlist/event/${draftEventId}`, headers: bearer('wisher') });
    expect(draft.statusCode).toBe(404);
    expect(draft.json().error.code).toBe('event_not_found');
    const missing = await app.inject({
      method: 'PUT',
      url: '/v1/consumer/me/wishlist/venue/00000000-0000-0000-0000-000000000000',
      headers: bearer('wisher'),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('venue_not_found');
  });

  it('rejects an unknown item type or a malformed id with 400', async () => {
    const type = await app.inject({ method: 'PUT', url: `/v1/consumer/me/wishlist/arena/${eventId}`, headers: bearer('wisher') });
    expect(type.statusCode).toBe(400);
    const id = await app.inject({ method: 'PUT', url: '/v1/consumer/me/wishlist/event/not-a-uuid', headers: bearer('wisher') });
    expect(id.statusCode).toBe(400);
  });

  it('drops a liked listing from the hydrated read once it is no longer public', async () => {
    await db.update(events).set({ status: 'draft' }).where(eq(events.id, eventId));
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist', headers: bearer('wisher') });
      expect(res.json().events).toEqual([]);
      // The like itself is kept (the id read is the cheap "paint the heart" path).
      const ids = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist/ids', headers: bearer('wisher') });
      expect(ids.json().events).toEqual([eventId]);
    } finally {
      await db.update(events).set({ status: 'published' }).where(eq(events.id, eventId));
    }
  });

  it('unlikes idempotently', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/v1/consumer/me/wishlist/event/${eventId}`, headers: bearer('wisher') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ liked: false });
    const again = await app.inject({ method: 'DELETE', url: `/v1/consumer/me/wishlist/event/${eventId}`, headers: bearer('wisher') });
    expect(again.statusCode).toBe(200);

    const ids = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist/ids', headers: bearer('wisher') });
    expect(ids.json()).toEqual({ events: [], memberships: [membershipId], venues: [venueId] });
  });

  it('is wiped by self-service account deletion', async () => {
    // The users row survives as a tombstone, so the FK cascade can't do this.
    const del = await app.inject({ method: 'DELETE', url: '/v1/consumer/me', headers: bearer('wisher') });
    expect(del.statusCode).toBe(204);
    const [{ n }] = (await db.execute(
      sql`select count(*)::int as n from wishlist_items w join users u on u.id = w.user_id where u.firebase_uid = 'fbuid_wishlist_a'`,
    )) as unknown as [{ n: number }];
    expect(n).toBe(0);
  });
});
