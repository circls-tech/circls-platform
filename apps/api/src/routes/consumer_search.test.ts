import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, db } from '../db/client.js';
import { arenas, events, memberships, tenants, venues } from '../db/schema/index.js';
import { likePattern } from '../services/consumer_service.js';
import { buildServer } from '../server.js';

// Consumer search (GET /v1/consumer/search) plus the `search` param on the
// cross-venue events / memberships lists. Integration-gated (needs Postgres).
// The DB is shared with other suites, so every assertion is scoped to the ids
// this file seeds — never to the whole result set.
const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe('likePattern', () => {
  it('lower-cases, trims and wraps in wildcards', () => {
    expect(likePattern('  Futsal Night ')).toBe('%futsal night%');
  });
  it('escapes the user’s own wildcard characters', () => {
    expect(likePattern('100% pass_1\\')).toBe('%100\\% pass\\_1\\\\%');
  });
});

describe.skipIf(!runIntegration)('consumer search', () => {
  let app: FastifyInstance;
  const tag = `srch${Date.now()}`;
  let tenantId: string;
  let venueId: string;
  let hiddenVenueId: string;
  let futsalId: string;
  let yogaId: string;
  let draftId: string;
  let pastId: string;
  let monthlyPassId: string;
  let percentPassId: string;

  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const search = async (qs: string) => {
    const res = await app.inject({ method: 'GET', url: `/v1/consumer/search?${qs}` });
    expect(res.statusCode).toBe(200);
    return res.json() as { events: { id: string }[]; memberships: { id: string }[]; venues: { id: string }[] };
  };

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    const [t] = await db
      .insert(tenants)
      .values({ name: `Search Org ${tag}`, slug: `search-org-${tag}`, status: 'active' })
      .returning();
    tenantId = t!.id;

    // A bookable venue (active arena) and one without an arena, which the
    // venues list hides even though its name matches.
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: `Turf Park ${tag}`, tags: ['football'], status: 'active' })
      .returning();
    venueId = v!.id;
    await db.insert(arenas).values({ venueId, name: 'Pitch 1', status: 'active' });
    const [hv] = await db
      .insert(venues)
      .values({ tenantId, name: `Turf Park Annex ${tag}`, status: 'active' })
      .returning();
    hiddenVenueId = hv!.id;

    const mkEvent = (
      name: string,
      opts: { venueId?: string | null; status?: 'published' | 'draft'; past?: boolean } = {},
    ) =>
      db
        .insert(events)
        .values({
          tenantId,
          venueId: opts.venueId === undefined ? venueId : opts.venueId,
          // A standalone (venue-less) event carries its own location.
          ...(opts.venueId === null ? { addressJson: { line1: '1 Park Rd', city: 'Pune' }, tzName: 'Asia/Kolkata' } : {}),
          name,
          startsAt: new Date(opts.past ? '2020-01-01T10:00:00Z' : '2031-01-01T10:00:00Z'),
          endsAt: new Date(opts.past ? '2020-01-01T12:00:00Z' : '2031-01-01T12:00:00Z'),
          pricePaise: 0,
          status: opts.status ?? 'published',
        })
        .returning()
        .then((r) => r[0]!.id);
    futsalId = await mkEvent(`${tag} Futsal Night`);
    yogaId = await mkEvent(`Yoga Morning ${tag}`, { venueId: null });
    draftId = await mkEvent(`${tag} Futsal Draft`, { status: 'draft' });
    pastId = await mkEvent(`${tag} Futsal Past`, { past: true });

    const [mp] = await db
      .insert(memberships)
      .values({ tenantId, venueId, name: `Monthly Pass ${tag}`, durationDays: 30, pricePaise: 1000, status: 'active' })
      .returning();
    monthlyPassId = mp!.id;
    const [pp] = await db
      .insert(memberships)
      .values({ tenantId, venueId: null, name: `100% Pass ${tag}`, durationDays: 30, pricePaise: 1000, status: 'active' })
      .returning();
    percentPassId = pp!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from memberships where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from arenas where venue_id in (${venueId}, ${hiddenVenueId})`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await app.close();
    await closeDb();
  });

  it('rejects a missing or blank term and an unknown type', async () => {
    for (const qs of ['', 'q=', 'q=%20%20', `q=${tag}&types=arena`, `q=${tag}&types=`]) {
      const res = await app.inject({ method: 'GET', url: `/v1/consumer/search?${qs}` });
      expect(res.statusCode, qs).toBe(400);
    }
  });

  it('matches the listing name, partially and case-insensitively', async () => {
    const body = await search(`q=${encodeURIComponent(`${tag} FUTSAL night`)}`);
    expect(ids(body.events)).toEqual([futsalId]);
    expect(body.memberships).toEqual([]);
    expect(body.venues).toEqual([]);
  });

  it('never surfaces a draft or past event, nor a venue without a bookable arena', async () => {
    const body = await search(`q=${encodeURIComponent(`${tag} futsal`)}`);
    expect(ids(body.events)).toEqual([futsalId]);
    expect(ids(body.events)).not.toContain(draftId);
    expect(ids(body.events)).not.toContain(pastId);
    const venuesBody = await search(`q=${encodeURIComponent(`turf park`)}&types=venue`);
    expect(ids(venuesBody.venues)).toContain(venueId);
    expect(ids(venuesBody.venues)).not.toContain(hiddenVenueId);
  });

  it('matching a venue name finds the venue, its events and its passes', async () => {
    const body = await search(`q=${encodeURIComponent(`turf park ${tag}`)}`);
    expect(ids(body.venues)).toEqual([venueId]);
    expect(ids(body.events)).toEqual([futsalId]);
    expect(ids(body.memberships)).toEqual([monthlyPassId]);
  });

  it('matching the organiser name finds everything they list, including standalone events and brand passes', async () => {
    const body = await search(`q=${encodeURIComponent(`search org ${tag}`)}&limit=50`);
    expect(ids(body.venues)).toEqual([venueId]);
    expect(new Set(ids(body.events))).toEqual(new Set([futsalId, yogaId]));
    expect(new Set(ids(body.memberships))).toEqual(new Set([monthlyPassId, percentPassId]));
  });

  it('matches a tag (sport) on venues', async () => {
    const body = await search(`q=football&types=venue&limit=50`);
    expect(ids(body.venues)).toContain(venueId);
  });

  it('limits the sections with `types`', async () => {
    const only = await search(`q=${encodeURIComponent(`search org ${tag}`)}&types=venue`);
    expect(ids(only.venues)).toEqual([venueId]);
    expect(only.events).toEqual([]);
    expect(only.memberships).toEqual([]);
    const two = await search(`q=${encodeURIComponent(`search org ${tag}`)}&types=event,membership`);
    expect(two.venues).toEqual([]);
    expect(two.events.length).toBeGreaterThan(0);
    expect(two.memberships.length).toBeGreaterThan(0);
  });

  it('treats % and _ in the term literally', async () => {
    const body = await search(`q=${encodeURIComponent(`100% pass ${tag}`)}`);
    expect(ids(body.memberships)).toEqual([percentPassId]);
    const under = await search(`q=${encodeURIComponent(`100_ pass ${tag}`)}`);
    expect(under.memberships).toEqual([]);
  });

  it('exposes the same term on the cross-venue events and memberships lists', async () => {
    const ev = await app.inject({ method: 'GET', url: `/v1/consumer/events?search=${encodeURIComponent(`morning ${tag}`)}` });
    expect(ev.statusCode).toBe(200);
    expect(ids(ev.json().rows)).toEqual([yogaId]);
    const ms = await app.inject({ method: 'GET', url: `/v1/consumer/memberships?search=${encodeURIComponent(`monthly pass ${tag}`)}` });
    expect(ms.statusCode).toBe(200);
    expect(ids(ms.json().rows)).toEqual([monthlyPassId]);
  });
});
