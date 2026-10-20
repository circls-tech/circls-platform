import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      owner: { uid: 'fbuid_ldowner', email: 'ldowner@x.com', email_verified: true },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { events, memberships, venues } = await import('../db/schema/index.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

interface ErrorBody {
  error: { code: string; details?: { missing?: string[] } };
}

describe.skipIf(!runIntegration)('listing drafts', () => {
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
      payload: { name: 'Drafts Co', slug: `ldco-${Date.now()}`, country: 'India', acceptTerms: true },
    });
    expect(t.statusCode).toBe(200);
    tenantId = t.json().id;
    const v = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Drafts Venue' },
    });
    expect(v.statusCode).toBe(200);
    venueId = v.json().id;
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it('an event is saved with only a name; review waits for dates, a location and a tier', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: { name: 'Someday Sixes', tiers: [] },
    });
    expect(created.statusCode).toBe(200);
    const ev = created.json() as { id: string; status: string; startsAt: string | null; venueId: string | null };
    expect(ev.status).toBe('draft');
    expect(ev.startsAt).toBeNull();
    expect(ev.venueId).toBeNull();

    const refused = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events/${ev.id}/publish`,
      headers: bearer('owner'),
    });
    expect(refused.statusCode).toBe(409);
    const body = refused.json() as ErrorBody;
    expect(body.error.code).toBe('event_incomplete');
    expect(body.error.details?.missing?.sort()).toEqual(['dates', 'location', 'tiers']);

    // One date without the other is a slip, not a draft.
    const half = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events`,
      headers: bearer('owner'),
      payload: { name: 'Half dated', tiers: [], startsAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(half.statusCode).toBe(400);
  });

  it('a venue event draft completes through edits and then goes to review', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/venues/${venueId}/events`,
      headers: bearer('owner'),
      payload: { name: 'Court night', tiers: [] },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { id: string }).id;

    const refused = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events/${id}/publish`,
      headers: bearer('owner'),
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as ErrorBody).error.details?.missing?.sort()).toEqual(['dates', 'tiers']);

    const start = new Date(Date.now() + 7 * 86_400_000);
    const end = new Date(start.getTime() + 2 * 3_600_000);
    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/events/${id}`,
      headers: bearer('owner'),
      payload: {
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        tiers: [{ name: 'Entry', pricePaise: 20000, capacity: null }],
      },
    });
    expect(edited.statusCode).toBe(200);

    const submitted = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/events/${id}/publish`,
      headers: bearer('owner'),
    });
    expect(submitted.statusCode).toBe(200);
    const [row] = await db.select({ status: events.status }).from(events).where(eq(events.id, id));
    expect(row?.status).toBe('pending_review');
  });

  it('a venue saved as a draft stays the partner’s own until submitted, and is not public', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/venues`,
      headers: bearer('owner'),
      payload: { name: 'Quiet Draft Venue', draft: true },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { id: string; status: string }).id;
    expect((created.json() as { status: string }).status).toBe('draft');

    const pub = await app.inject({ method: 'GET', url: `/v1/consumer/venues/${id}` });
    expect(pub.statusCode).toBe(404);

    const submitted = await app.inject({ method: 'POST', url: `/v1/venues/${id}/submit`, headers: bearer('owner') });
    expect(submitted.statusCode).toBe(200);
    expect((submitted.json() as { status: string }).status).toBe('pending_review');
    const [row] = await db.select({ status: venues.status }).from(venues).where(eq(venues.id, id));
    expect(row?.status).toBe('pending_review');

    const again = await app.inject({ method: 'POST', url: `/v1/venues/${id}/submit`, headers: bearer('owner') });
    expect(again.statusCode).toBe(409);
    expect((again.json() as ErrorBody).error.code).toBe('venue_not_draft');
  });

  it('a plan saved as a draft needs no tiers, and review waits for one', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/memberships`,
      headers: bearer('owner'),
      payload: { name: 'Someday Pass', draft: true },
    });
    expect(created.statusCode).toBe(200);
    const plan = created.json() as { id: string; status: string; tiers: unknown[] };
    expect(plan.status).toBe('draft');
    expect(plan.tiers).toHaveLength(0);

    // Without the draft flag the old rule stands.
    const strict = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/memberships`,
      headers: bearer('owner'),
      payload: { name: 'No tiers, no draft' },
    });
    expect(strict.statusCode).toBe(400);

    const refused = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/memberships/${plan.id}/submit`,
      headers: bearer('owner'),
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as ErrorBody).error.code).toBe('membership_incomplete');

    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/memberships/${plan.id}`,
      headers: bearer('owner'),
      payload: { tiers: [{ name: 'Monthly', pricePaise: 99900, durationDays: 30, capacity: null }] },
    });
    expect(edited.statusCode).toBe(200);

    const submitted = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/memberships/${plan.id}/submit`,
      headers: bearer('owner'),
    });
    expect(submitted.statusCode).toBe(200);
    const [row] = await db.select({ status: memberships.status }).from(memberships).where(eq(memberships.id, plan.id));
    expect(row?.status).toBe('pending_review');
  });
});
