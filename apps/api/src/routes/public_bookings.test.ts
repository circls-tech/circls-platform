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

const { closeDb } = await import('../db/client.js');
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
      payload: { name: 'Public Co', slug: `pbco-${Date.now()}` },
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
});
