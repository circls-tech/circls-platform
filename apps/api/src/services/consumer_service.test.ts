/**
 * Consumer visibility — the security-critical rule: a listing is public iff it
 * is approved AND its tenant is active. Integration (RUN_INTEGRATION + DB).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { arenas, bookings, events, memberships, slots, tenants, users, venues } from '../db/schema/index.js';
import {
  getMyBookingDetail,
  getPublicMembershipById,
  getPublicVenue,
  listPublicArenas,
  listPublicEvents,
  listPublicMemberships,
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

describe.skipIf(!runIntegration)('getPublicMembershipById', () => {
  const tag = `mbyid-${Date.now()}`;
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
    const [t] = await db.insert(tenants).values({ name: `ById Brand ${tag}`, slug: tag }).returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: `ById Venue ${tag}`, status: 'active', tags: ['Tennis'] })
      .returning();
    venueId = v!.id;
    const [pv] = await db
      .insert(venues)
      .values({ tenantId, name: `ById Pending ${tag}`, status: 'pending_review' })
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

    const [st] = await db.insert(tenants).values({ name: `ByIdSusp ${tag}`, slug: `${tag}-susp`, status: 'suspended' }).returning();
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

  it('returns a venue-scoped membership with scope', async () => {
    const m = await getPublicMembershipById(scopedId);
    expect(m).not.toBeNull();
    expect(m!.id).toBe(scopedId);
    expect(m!.venueId).toBe(venueId);
    expect(m!.scopeName).toBe(`ById Venue ${tag}`);
    expect(m!.venueTags).toEqual(['Tennis']);
  });

  it('returns a tenant-wide membership with brand scope and empty tags', async () => {
    const m = await getPublicMembershipById(tenantWideId);
    expect(m).not.toBeNull();
    expect(m!.venueId).toBeNull();
    expect(m!.scopeName).toBe(`ById Brand ${tag}`);
    expect(m!.venueTags).toEqual([]);
  });

  it('returns null for inactive, non-active-venue-scoped, suspended-tenant, and unknown', async () => {
    expect(await getPublicMembershipById(inactiveId)).toBeNull();
    expect(await getPublicMembershipById(pendingVenueMembId)).toBeNull();
    expect(await getPublicMembershipById(suspMembId)).toBeNull();
    expect(await getPublicMembershipById('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe.skipIf(!runIntegration)('listPublicMemberships (venue scope enrichment)', () => {
  const tag = `mvscope-${Date.now()}`;
  let tenantId: string;
  let venueId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db.insert(tenants).values({ name: `VScope Brand ${tag}`, slug: tag }).returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: `VScope Venue ${tag}`, status: 'active', tags: ['Padel'] })
      .returning();
    venueId = v!.id;
    await db.insert(memberships).values([
      { tenantId, venueId, name: 'VScoped', durationDays: 30, status: 'active' },
      { tenantId, venueId: null, name: 'VWide', durationDays: 30, status: 'active' },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`delete from memberships where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
  });

  it('returns venue-scoped + tenant-wide with scope fields', async () => {
    const rows = await listPublicMemberships(venueId);
    const scoped = rows.find((m) => m.name === 'VScoped')!;
    const wide = rows.find((m) => m.name === 'VWide')!;
    expect(scoped.scopeName).toBe(`VScope Venue ${tag}`);
    expect(scoped.venueTags).toEqual(['Padel']);
    expect(wide.venueId).toBeNull();
    expect(wide.scopeName).toBe(`VScope Brand ${tag}`);
    expect(wide.venueTags).toEqual([]);
  });
});

// getMyBookingDetail: a consumer's own booking, resolved per item type, scoped
// to the requesting user (created_by OR customer_user_id) so other users 404.
describe.skipIf(!runIntegration)('consumer booking detail (getMyBookingDetail)', () => {
  const tag = `bkdetail-${Date.now()}`;
  let tenantId: string;
  let venueId: string;
  let arenaId: string;
  let userA: string;
  let userB: string;
  let membershipId: string;
  let eventId: string;
  let slotBookingId: string;
  let eventBookingId: string;
  let membershipBookingId: string;
  let customerBookingId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db.insert(tenants).values({ name: 'BkDetail', slug: tag }).returning();
    tenantId = t!.id;
    const [v] = await db.insert(venues).values({ tenantId, name: `BkD Venue ${tag}`, status: 'active' }).returning();
    venueId = v!.id;
    const [a] = await db.insert(arenas).values({ venueId, name: 'Center Court', status: 'active' }).returning();
    arenaId = a!.id;

    const [ua] = await db.insert(users).values({ firebaseUid: `${tag}-a` }).returning({ id: users.id });
    userA = ua!.id;
    const [ub] = await db.insert(users).values({ firebaseUid: `${tag}-b` }).returning({ id: users.id });
    userB = ub!.id;

    const [m] = await db
      .insert(memberships)
      .values({ tenantId, name: 'Gold Plan', durationDays: 90, pricePaise: 500000, status: 'active' })
      .returning({ id: memberships.id });
    membershipId = m!.id;

    const [ev] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Sunday Smash',
        description: 'A friendly tournament',
        startsAt: new Date(Date.now() + DAY),
        endsAt: new Date(Date.now() + DAY + 2 * HOUR),
        pricePaise: 30000,
        status: 'published',
      })
      .returning({ id: events.id });
    eventId = ev!.id;

    // Slot booking + one booked slot pointing at it.
    const [sb] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'slot',
        slotArenaId: arenaId,
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        totalPaise: 80000,
        createdByUserId: userA,
        customerUserId: userA,
      })
      .returning({ id: bookings.id });
    slotBookingId = sb!.id;
    await db.insert(slots).values({
      tenantId,
      arenaId,
      timeRange: '[2026-06-10T10:00:00Z,2026-06-10T11:00:00Z)',
      pricePaise: 80000,
      status: 'booked',
      bookingId: slotBookingId,
    });

    const [eb] = await db
      .insert(bookings)
      .values({
        tenantId,
        venueId,
        itemType: 'event',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        totalPaise: 30000,
        itemData: { eventId, eventName: 'Sunday Smash' },
        createdByUserId: userA,
        customerUserId: userA,
      })
      .returning({ id: bookings.id });
    eventBookingId = eb!.id;

    const [mb] = await db
      .insert(bookings)
      .values({
        tenantId,
        itemType: 'membership',
        channel: 'circls',
        paymentMethod: 'razorpay_route',
        status: 'confirmed',
        totalPaise: 500000,
        itemData: { membershipId },
        createdByUserId: userA,
        customerUserId: userA,
      })
      .returning({ id: bookings.id });
    membershipBookingId = mb!.id;

    // Booked BY user A FOR user B — must be visible to B via customer_user_id.
    const [cb] = await db
      .insert(bookings)
      .values({
        tenantId,
        itemType: 'membership',
        channel: 'circls',
        paymentMethod: 'free',
        status: 'confirmed',
        totalPaise: 0,
        itemData: { membershipId },
        createdByUserId: userA,
        customerUserId: userB,
      })
      .returning({ id: bookings.id });
    customerBookingId = cb!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from slots where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from bookings where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from memberships where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from arenas where venue_id = ${venueId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from users where id in (${userA}, ${userB})`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
  });

  it('resolves a slot booking with its booked slots', async () => {
    const d = await getMyBookingDetail(userA, slotBookingId);
    expect(d.itemType).toBe('slot');
    expect(d.venueName).toBe(`BkD Venue ${tag}`);
    expect(d.paymentMethod).toBe('razorpay_route');
    expect(d.event).toBeNull();
    expect(d.membership).toBeNull();
    expect(d.slots).toHaveLength(1);
    expect(d.slots[0]!.arenaName).toBe('Center Court');
    expect(d.slots[0]!.pricePaise).toBe(80000);
  });

  it('resolves an event booking with the event block', async () => {
    const d = await getMyBookingDetail(userA, eventBookingId);
    expect(d.itemType).toBe('event');
    expect(d.event?.name).toBe('Sunday Smash');
    expect(d.event?.description).toBe('A friendly tournament');
    expect(d.slots).toHaveLength(0);
    expect(d.membership).toBeNull();
  });

  it('resolves a membership booking with the membership block (title = plan name)', async () => {
    const d = await getMyBookingDetail(userA, membershipBookingId);
    expect(d.itemType).toBe('membership');
    expect(d.venueName).toBe('Gold Plan');
    expect(d.membership?.name).toBe('Gold Plan');
    expect(d.membership?.durationDays).toBe(90);
    expect(d.event).toBeNull();
    expect(d.slots).toHaveLength(0);
  });

  it('is visible to the customer it was booked for (customer_user_id path)', async () => {
    const d = await getMyBookingDetail(userB, customerBookingId);
    expect(d.id).toBe(customerBookingId);
    expect(d.totalPaise).toBe(0);
  });

  it('404s when a different user requests a booking that is not theirs', async () => {
    await expect(getMyBookingDetail(userB, membershipBookingId)).rejects.toMatchObject({
      code: 'booking_not_found',
    });
  });
});
