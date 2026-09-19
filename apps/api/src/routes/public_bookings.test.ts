import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Firebase verifier mock — only needed to provision the owner who creates the
// tenant/venue/arena/slots. The public booking surface itself authenticates via
// API keys (Bearer ck_…), not Firebase.
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_pbowner', email: 'pbowner@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { sql } = await import('drizzle-orm');
const { buildServer } = await import('../server.js');
const { createApiKey } = await import('../services/api_keys_service.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const withKey = (t: string, key: string) => ({ ...bearer(t), 'idempotency-key': key });

describe.skipIf(!runIntegration)('public bookings — API-key role enforcement (H2)', () => {
  let app: FastifyInstance;
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  let otherArenaId: string;
  let openSlotIds: string[];
  let readKey: string;
  let writeKey: string;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const t = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Public Co', slug: `pbco-${Date.now()}`, country: 'India', acceptTerms: true },
    });
    tenantId = t.json().id;

    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Public Venue' },
    });
    venueId = v.json().id;

    const a = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Public Arena', slotDurationMin: 60 },
    });
    arenaId = a.json().id;

    // A SECOND venue (same tenant is fine — the point is that the arena does
    // NOT belong to `venueId`, so availability for venueId must reject it).
    const v2 = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Other Venue' },
    });
    const otherVenueId = v2.json().id;
    const a2 = await app.inject({
      method: 'POST',
      url: `/v1/venues/${otherVenueId}/arenas`,
      headers: bearer('owner'),
      payload: { name: 'Other Arena', slotDurationMin: 60 },
    });
    otherArenaId = a2.json().id;

    const releaseRes = await app.inject({
      method: 'POST',
      url: `/v1/arenas/${arenaId}/slots/release`,
      headers: withKey('owner', `pbrel-${Date.now()}`),
      payload: {
        startDate: '2027-06-01',
        endDate: '2027-06-01',
        quantizationMin: 60,
        cells: [
          { dayOfWeek: 2, startTimeMin: 360, durationMin: 60, price: 10000 },
          { dayOfWeek: 2, startTimeMin: 420, durationMin: 60, price: 12000 },
        ],
      },
    });
    expect(releaseRes.statusCode).toBe(200);

    const slotsRes = await app.inject({
      method: 'GET',
      url: `/v1/arenas/${arenaId}/slots?from=2027-06-01T00:00:00Z&to=2027-06-02T00:00:00Z`,
      headers: bearer('owner'),
    });
    const allSlots = slotsRes.json() as Array<{ id: string; status: string }>;
    openSlotIds = allSlots.filter((s) => s.status === 'open').map((s) => s.id);
    expect(openSlotIds.length).toBeGreaterThanOrEqual(2);

    // Approve the venue and arena (admin review is out of scope here). The
    // public API only sells what the consumer portal would, and new listings
    // start in review.
    await db.execute(sql`update venues set status = 'active' where id = ${venueId}::uuid`);
    await db.execute(sql`update arenas set status = 'active' where id = ${arenaId}::uuid`);

    // Mint a read-role and a write-role key scoped to this tenant.
    readKey = (await createApiKey({ tenantId, name: 'reader', role: 'read' })).plaintext;
    writeKey = (await createApiKey({ tenantId, name: 'writer', role: 'write' })).plaintext;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('rejects a read-role key on POST /api/v1/bookings (403 api_key_write_forbidden)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${readKey}` },
      payload: {
        slotIds: [openSlotIds[0]],
        customer: { name: 'Reader', contact: '+91-9999900000' },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('api_key_write_forbidden');
  });

  it('allows a write-role key past the role check and creates an aggregator booking', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${writeKey}` },
      payload: {
        slotIds: [openSlotIds[0]],
        customer: { name: 'Writer', contact: '+91-9999900001' },
      },
    });
    // Past the role gate: the booking is created and stamped aggregator.
    expect(res.statusCode).toBe(201);
    expect(res.json().channel).toBe('aggregator');
  });

  // H5 — cross-tenant/cross-venue slot enumeration via arenaId.
  it('rejects an arenaId that does not belong to the venue (404 arena_not_found)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/venues/${venueId}/availability?from=2027-06-01T00:00:00Z&to=2027-06-02T00:00:00Z&arenaId=${otherArenaId}`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('arena_not_found');
  });

  it('allows an arenaId that DOES belong to the venue', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/venues/${venueId}/availability?from=2027-06-01T00:00:00Z&to=2027-06-02T00:00:00Z&arenaId=${arenaId}`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { arenas: Array<{ arenaId: string }> };
    expect(body.arenas).toHaveLength(1);
    expect(body.arenas[0]?.arenaId).toBe(arenaId);
  });

  // The public API used to check the key's tenant and nothing else, so a
  // closed, rejected or never-reviewed venue or arena could be listed and
  // booked through it. It now sells only what the consumer portal would.
  describe('only live venues and arenas are for sale', () => {
    const WINDOW = 'from=2027-06-01T00:00:00Z&to=2027-06-02T00:00:00Z';
    const availability = (query = '') =>
      app.inject({
        method: 'GET',
        url: `/api/v1/venues/${venueId}/availability?${WINDOW}${query}`,
        headers: { authorization: `Bearer ${readKey}` },
      });
    const book = (slotIds: string[]) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/bookings',
        headers: { authorization: `Bearer ${writeKey}` },
        payload: { slotIds, customer: { name: 'Aggregator', contact: '+91-9999900009' } },
      });
    const setOpen = (kind: 'venues' | 'arenas', id: string, action: 'close' | 'reopen') =>
      app.inject({ method: 'POST', url: `/v1/${kind}/${id}/${action}`, headers: bearer('owner') });

    /** A second live arena in the same venue, with one open slot of its own. */
    async function secondArena(): Promise<{ id: string; slotId: string }> {
      const a = await app.inject({
        method: 'POST',
        url: `/v1/venues/${venueId}/arenas`,
        headers: bearer('owner'),
        payload: { name: `Second Arena ${Date.now()}`, slotDurationMin: 60 },
      });
      const id = a.json().id as string;
      await db.execute(sql`update arenas set status = 'active' where id = ${id}::uuid`);
      await app.inject({
        method: 'POST',
        url: `/v1/arenas/${id}/slots/release`,
        headers: withKey('owner', `pbrel2-${Date.now()}`),
        payload: {
          startDate: '2027-06-01',
          endDate: '2027-06-01',
          quantizationMin: 60,
          cells: [{ dayOfWeek: 2, startTimeMin: 600, durationMin: 60, price: 9000 }],
        },
      });
      const slotsRes = await app.inject({
        method: 'GET',
        url: `/v1/arenas/${id}/slots?${WINDOW}`,
        headers: bearer('owner'),
      });
      const slotId = (slotsRes.json() as Array<{ id: string; status: string }>).find(
        (x) => x.status === 'open',
      )!.id;
      return { id, slotId };
    }

    it('refuses availability for a closed venue, and serves it again once reopened', async () => {
      await setOpen('venues', venueId, 'close');
      const closed = await availability();
      expect(closed.statusCode).toBe(409);
      expect(closed.json().error.code).toBe('venue_not_bookable');

      await setOpen('venues', venueId, 'reopen');
      expect((await availability()).statusCode).toBe(200);
    });

    it('refuses a booking at a closed venue', async () => {
      await setOpen('venues', venueId, 'close');
      const res = await book([openSlotIds[1]!]);
      await setOpen('venues', venueId, 'reopen');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('venue_not_bookable');
    });

    it("leaves a closed arena out of the venue's availability", async () => {
      const second = await secondArena();
      await setOpen('arenas', second.id, 'close');
      const res = await availability();
      await setOpen('arenas', second.id, 'reopen');
      const ids = (res.json() as { arenas: Array<{ arenaId: string }> }).arenas.map((a) => a.arenaId);
      expect(ids).toContain(arenaId);
      expect(ids).not.toContain(second.id);
    });

    it('refuses availability asked for a closed arena by id', async () => {
      const second = await secondArena();
      await setOpen('arenas', second.id, 'close');
      const res = await availability(`&arenaId=${second.id}`);
      await setOpen('arenas', second.id, 'reopen');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('arena_not_bookable');
    });

    // A booking can span arenas, so checking only the first slot's arena let a
    // closed one ride along behind a live one.
    it('refuses a booking where any slot is on a closed arena, even behind a live one', async () => {
      const second = await secondArena();
      await setOpen('arenas', second.id, 'close');
      const res = await book([openSlotIds[1]!, second.slotId]);
      await setOpen('arenas', second.id, 'reopen');
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('arena_not_bookable');
    });

    it('never offers an arena still awaiting review', async () => {
      const a = await app.inject({
        method: 'POST',
        url: `/v1/venues/${venueId}/arenas`,
        headers: bearer('owner'),
        payload: { name: `Unreviewed Arena ${Date.now()}`, slotDurationMin: 60 },
      });
      const ids = ((await availability()).json() as { arenas: Array<{ arenaId: string }> }).arenas.map(
        (x) => x.arenaId,
      );
      expect(ids).not.toContain(a.json().id);
    });
  });
});
