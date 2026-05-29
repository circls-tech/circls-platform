/**
 * Consumer visibility — the security-critical rule: a listing is public iff it
 * is approved AND its tenant is active. Integration (RUN_INTEGRATION + DB).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { arenas, events, memberships, tenants, venues } from '../db/schema/index.js';
import {
  getPublicVenue,
  listPublicArenas,
  listPublicEvents,
  listPublicMembershipsAcrossVenues,
  listPublicUpcomingEvents,
  listPublicVenues,
} from './consumer_service.js';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

// One shared postgres-js pool per process: close it exactly once, after every
// block. (closeDb() ends the pool permanently, so it can't live in a per-block
// afterAll once there are multiple describe blocks in this file.)
afterAll(async () => {
  await closeDb();
});

describe.skipIf(!runIntegration)('consumer visibility', () => {
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  const tag = `consumervis-${Date.now()}`;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db.insert(tenants).values({ name: 'ConsumerVis', slug: tag }).returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: `Vis Venue ${tag}`, status: 'pending_review' })
      .returning();
    venueId = v!.id;
    const [a] = await db
      .insert(arenas)
      .values({ venueId, name: 'Court', status: 'pending_review' })
      .returning();
    arenaId = a!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from arenas where venue_id = ${venueId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
  });

  it('hides a pending_review venue', async () => {
    expect(await getPublicVenue(venueId)).toBeNull();
    const list = await listPublicVenues({ search: tag });
    expect(list.find((v) => v.id === venueId)).toBeUndefined();
  });

  it('shows an approved venue via getPublicVenue, but listPublicVenues needs an active arena (§12.1)', async () => {
    await db.update(venues).set({ status: 'active' }).where(eq(venues.id, venueId));
    // Single-venue read is unchanged by §12.1 — it surfaces an approved venue.
    expect((await getPublicVenue(venueId))?.id).toBe(venueId);
    // Listing requires ≥1 active arena; the arena is still pending_review → hidden.
    const noArena = await listPublicVenues({ search: tag });
    expect(noArena.find((v) => v.id === venueId)).toBeUndefined();
  });

  it('lists the venue once it has an active arena, and only lists approved arenas (§12.1)', async () => {
    // venue is active; arena still pending_review → excluded from arena listing.
    expect(await listPublicArenas(venueId)).toHaveLength(0);
    await db.update(arenas).set({ status: 'active' }).where(eq(arenas.id, arenaId));
    const arenaList = await listPublicArenas(venueId);
    expect(arenaList.find((a) => a.id === arenaId)).toBeTruthy();
    // Now that a bookable arena exists, the venue appears in the public listing.
    const venueList = await listPublicVenues({ search: tag });
    expect(venueList.find((v) => v.id === venueId)).toBeTruthy();
  });

  it('hides everything when the tenant is suspended', async () => {
    await db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, tenantId));
    expect(await getPublicVenue(venueId)).toBeNull();
    await expect(listPublicArenas(venueId)).rejects.toMatchObject({ code: 'venue_not_found' });
  });
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// §12.2 (per-venue) + §12.3 (cross-venue): published + upcoming only, ascending.
describe.skipIf(!runIntegration)('consumer events visibility & ordering', () => {
  const tag = `evvis-${Date.now()}`;
  let tenantId: string;
  let venueId: string;
  let suspTenantId: string;
  let suspVenueId: string;
  let nearId: string;
  let farId: string;
  let suspEventId: string;

  beforeAll(async () => {
    await pingDb();
    const now = Date.now();
    // Visible tenant + venue (with tags, for the cross-venue card fields).
    const [t] = await db.insert(tenants).values({ name: `EvVis ${tag}`, slug: tag }).returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: `Ev Venue ${tag}`, status: 'active', tags: ['Badminton', 'Tennis'] })
      .returning();
    venueId = v!.id;
    const mkEvent = async (name: string, startsMs: number, endsMs: number, status: 'published' | 'draft') => {
      const [e] = await db
        .insert(events)
        .values({
          tenantId,
          venueId,
          name,
          startsAt: new Date(startsMs),
          endsAt: new Date(endsMs),
          status,
        })
        .returning();
      return e!.id;
    };
    // Past (ended yesterday), near (starts +1d), far (starts +3d), and a draft future.
    await mkEvent('Past', now - 2 * DAY, now - DAY, 'published');
    nearId = await mkEvent('Near', now + DAY, now + DAY + 2 * HOUR, 'published');
    farId = await mkEvent('Far', now + 3 * DAY, now + 3 * DAY + 2 * HOUR, 'published');
    await mkEvent('Draft', now + DAY, now + DAY + 2 * HOUR, 'draft');

    // Suspended tenant with an active venue + a future published event → must stay hidden.
    const [st] = await db.insert(tenants).values({ name: `EvSusp ${tag}`, slug: `${tag}-susp`, status: 'suspended' }).returning();
    suspTenantId = st!.id;
    const [sv] = await db.insert(venues).values({ tenantId: suspTenantId, name: `Susp Venue ${tag}`, status: 'active' }).returning();
    suspVenueId = sv!.id;
    const [se] = await db
      .insert(events)
      .values({ tenantId: suspTenantId, venueId: suspVenueId, name: 'SuspEvent', startsAt: new Date(now + DAY), endsAt: new Date(now + DAY + 2 * HOUR), status: 'published' })
      .returning();
    suspEventId = se!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from events where tenant_id in (${tenantId}, ${suspTenantId})`);
    await db.execute(sql`delete from venues where tenant_id in (${tenantId}, ${suspTenantId})`);
    await db.execute(sql`delete from tenants where id in (${tenantId}, ${suspTenantId})`);
  });

  it('listPublicEvents hides past/draft events and sorts ascending (§12.2)', async () => {
    const rows = await listPublicEvents(venueId);
    const ids = rows.map((e) => e.id);
    expect(ids).toEqual([nearId, farId]); // ascending by starts_at, past + draft excluded
  });

  it('listPublicUpcomingEvents spans venues, excludes past + suspended-tenant, ascending (§12.3)', async () => {
    const rows = await listPublicUpcomingEvents({});
    const mine = rows.filter((e) => e.id === nearId || e.id === farId);
    expect(mine.map((e) => e.id)).toEqual([nearId, farId]);
    // Suspended tenant's event never surfaces.
    expect(rows.find((e) => e.id === suspEventId)).toBeUndefined();
    // Enriched with owning venue's name + tags for the card.
    const near = rows.find((e) => e.id === nearId)!;
    expect(near.venueName).toBe(`Ev Venue ${tag}`);
    expect(near.venueTags).toEqual(['Badminton', 'Tennis']);
  });

  it('honours the limit cap', async () => {
    const rows = await listPublicUpcomingEvents({ limit: 1 });
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});

// §12.4: all active memberships across visible tenants, with scope labelling.
describe.skipIf(!runIntegration)('consumer memberships across venues', () => {
  const tag = `mvis-${Date.now()}`;
  let tenantId: string;
  let venueId: string;
  let pendingVenueId: string;
  let suspTenantId: string;
  let scopedId: string;
  let tenantWideId: string;
  let inactiveId: string;
  let pendingVenueMembId: string;
  let suspMembId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db.insert(tenants).values({ name: `MVis Brand ${tag}`, slug: tag }).returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: `M Venue ${tag}`, status: 'active', tags: ['Squash'] })
      .returning();
    venueId = v!.id;
    const [pv] = await db
      .insert(venues)
      .values({ tenantId, name: `M Pending Venue ${tag}`, status: 'pending_review' })
      .returning();
    pendingVenueId = pv!.id;

    const mkMemb = async (name: string, venue: string | null, status: 'active' | 'inactive') => {
      const [m] = await db
        .insert(memberships)
        .values({ tenantId, venueId: venue, name, durationDays: 30, status })
        .returning();
      return m!.id;
    };
    scopedId = await mkMemb('Scoped', venueId, 'active');
    tenantWideId = await mkMemb('Wide', null, 'active');
    inactiveId = await mkMemb('Inactive', venueId, 'inactive');
    pendingVenueMembId = await mkMemb('OnPendingVenue', pendingVenueId, 'active');

    // Suspended tenant with an active membership → hidden.
    const [st] = await db.insert(tenants).values({ name: `MSusp ${tag}`, slug: `${tag}-susp`, status: 'suspended' }).returning();
    suspTenantId = st!.id;
    const [sm] = await db
      .insert(memberships)
      .values({ tenantId: suspTenantId, venueId: null, name: 'SuspWide', durationDays: 30, status: 'active' })
      .returning();
    suspMembId = sm!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from memberships where tenant_id in (${tenantId}, ${suspTenantId})`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id in (${tenantId}, ${suspTenantId})`);
  });

  it('returns active memberships with correct scope labels (§12.4)', async () => {
    const rows = await listPublicMembershipsAcrossVenues({});
    const byId = new Map(rows.map((m) => [m.id, m]));

    // Venue-scoped: venueId set, scopeName = venue name, venueTags = venue tags.
    const scoped = byId.get(scopedId)!;
    expect(scoped.venueId).toBe(venueId);
    expect(scoped.scopeName).toBe(`M Venue ${tag}`);
    expect(scoped.venueTags).toEqual(['Squash']);

    // Tenant-wide: venueId null, scopeName = tenant/brand name, venueTags empty.
    const wide = byId.get(tenantWideId)!;
    expect(wide.venueId).toBeNull();
    expect(wide.scopeName).toBe(`MVis Brand ${tag}`);
    expect(wide.venueTags).toEqual([]);
  });

  it('excludes inactive, non-active-venue-scoped, and suspended-tenant memberships (§12.4)', async () => {
    const rows = await listPublicMembershipsAcrossVenues({});
    const ids = new Set(rows.map((m) => m.id));
    expect(ids.has(inactiveId)).toBe(false); // status != active
    expect(ids.has(pendingVenueMembId)).toBe(false); // owning venue not active
    expect(ids.has(suspMembId)).toBe(false); // owning tenant suspended
  });
});
