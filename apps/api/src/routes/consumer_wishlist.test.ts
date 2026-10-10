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
const { events, memberships, tenants, venues, wishlistItems } = await import('../db/schema/index.js');
const { MAX_WISHLIST_ITEMS } = await import('../services/wishlist_service.js');
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
  let secondEventId: string;

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
    const [e2] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Wishlist Second Event',
        startsAt: new Date('2031-01-03T10:00:00Z'),
        endsAt: new Date('2031-01-03T12:00:00Z'),
        pricePaise: 0,
        status: 'published',
      })
      .returning();
    secondEventId = e2!.id;
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

  it('rejects an unknown item type with 400 and a malformed id with 404 (like /me/bookings/:id)', async () => {
    const type = await app.inject({ method: 'PUT', url: `/v1/consumer/me/wishlist/arena/${eventId}`, headers: bearer('wisher') });
    expect(type.statusCode).toBe(400);
    const id = await app.inject({ method: 'PUT', url: '/v1/consumer/me/wishlist/event/not-a-uuid', headers: bearer('wisher') });
    expect(id.statusCode).toBe(404);
    expect(id.json().error.code).toBe('event_not_found');
  });

  it('lists each section most-recently-liked first', async () => {
    // The first event was liked earlier in the suite; like a second one now.
    await db.execute(sql`update wishlist_items set created_at = created_at - interval '1 minute'
      where user_id = (select id from users where firebase_uid = 'fbuid_wishlist_a')`);
    const res = await app.inject({ method: 'PUT', url: `/v1/consumer/me/wishlist/event/${secondEventId}`, headers: bearer('wisher') });
    expect(res.statusCode).toBe(200);
    const full = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist', headers: bearer('wisher') });
    expect(full.json().events.map((e: { id: string }) => e.id)).toEqual([secondEventId, eventId]);
    const ids = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist/ids', headers: bearer('wisher') });
    expect(ids.json().events).toEqual([secondEventId, eventId]);
    await app.inject({ method: 'DELETE', url: `/v1/consumer/me/wishlist/event/${secondEventId}`, headers: bearer('wisher') });
  });

  it('rolls a like on a past date of a recurring event forward to the next date', async () => {
    const seriesId = crypto.randomUUID();
    const mk = (name: string, startsAt: string, endsAt: string) =>
      db
        .insert(events)
        .values({ tenantId, venueId, seriesId, name, startsAt: new Date(startsAt), endsAt: new Date(endsAt), pricePaise: 0, status: 'published' })
        .returning()
        .then((r) => r[0]!.id);
    // Liked while upcoming, then it "passes" (endsAt moved into the past).
    const past = await mk('Weekly Futsal (week 1)', '2031-02-01T10:00:00Z', '2031-02-01T12:00:00Z');
    const next = await mk('Weekly Futsal (week 2)', '2031-02-08T10:00:00Z', '2031-02-08T12:00:00Z');
    const later = await mk('Weekly Futsal (week 3)', '2031-02-15T10:00:00Z', '2031-02-15T12:00:00Z');
    const like = await app.inject({ method: 'PUT', url: `/v1/consumer/me/wishlist/event/${past}`, headers: bearer('wisher') });
    expect(like.statusCode).toBe(200);
    const likedAtBefore = (await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist', headers: bearer('wisher') }))
      .json().events.find((e: { id: string }) => e.id === past).likedAt;
    await db.update(events).set({ startsAt: new Date('2020-01-01T10:00:00Z'), endsAt: new Date('2020-01-01T12:00:00Z') }).where(eq(events.id, past));

    const full = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist', headers: bearer('wisher') });
    const rolled = full.json().events.find((e: { id: string }) => e.id === next);
    expect(rolled).toBeDefined();
    expect(rolled.likedAt).toBe(likedAtBefore);
    expect(full.json().events.map((e: { id: string }) => e.id)).not.toContain(later);
    // The like row itself moved, so the heart on the next date's card is filled.
    const ids = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist/ids', headers: bearer('wisher') });
    expect(ids.json().events).toContain(next);
    expect(ids.json().events).not.toContain(past);
    await app.inject({ method: 'DELETE', url: `/v1/consumer/me/wishlist/event/${next}`, headers: bearer('wisher') });
  });

  it('caps the wishlist per user with 409 wishlist_full', async () => {
    // Fill the other user's wishlist straight in the DB (ids need not resolve).
    const me = await app.inject({ method: 'GET', url: '/v1/consumer/me', headers: bearer('other') });
    expect(me.statusCode).toBe(200);
    const [u] = (await db.execute(sql`select id from users where firebase_uid = 'fbuid_wishlist_b'`)) as unknown as [{ id: string }];
    await db.insert(wishlistItems).values(
      Array.from({ length: MAX_WISHLIST_ITEMS }, () => ({ userId: u.id, itemType: 'venue' as const, itemId: crypto.randomUUID() })),
    );
    const full = await app.inject({ method: 'PUT', url: `/v1/consumer/me/wishlist/event/${eventId}`, headers: bearer('other') });
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe('wishlist_full');
    // Re-liking something already there is still fine at the cap.
    await db.insert(wishlistItems).values({ userId: u.id, itemType: 'venue', itemId: venueId }).onConflictDoNothing();
    const again = await app.inject({ method: 'PUT', url: `/v1/consumer/me/wishlist/venue/${venueId}`, headers: bearer('other') });
    expect(again.statusCode).toBe(200);
    // The reads stay bounded at the cap even with an over-cap row behind them.
    const ids = await app.inject({ method: 'GET', url: '/v1/consumer/me/wishlist/ids', headers: bearer('other') });
    expect(ids.json().venues).toHaveLength(MAX_WISHLIST_ITEMS);
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
