/**
 * Consumer service (subproject E). Read + book surface for the public
 * circls.app portal.
 *
 * Visibility rule (subproject B, decision 4): a listing is public iff it is in
 * its approved state AND the owning tenant is not suspended. Every read here
 * enforces that — the consumer portal must never surface a pending_review,
 * rejected, or suspended-tenant listing.
 *
 * Booking/purchase reuse the existing services (prepareOnlineBookingWithPayment,
 * bookEvent, purchaseMembership) but first re-check public visibility so a
 * consumer can't book against an unapproved venue by guessing ids.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { arenas } from '../db/schema/arenas.js';
import { bookings } from '../db/schema/bookings.js';
import { events, type Event } from '../db/schema/events.js';
import { memberships, type Membership } from '../db/schema/memberships.js';
import { slots } from '../db/schema/slots.js';
import { tenants } from '../db/schema/tenants.js';
import { venues, type Venue } from '../db/schema/venues.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { prepareOnlineBookingWithPayment, bookEvent } from './booking_service.js';
import type { PrepareOnlineBookingResult, BookEventResult } from './booking_service.js';
import { purchaseMembership } from './memberships_service.js';
import type { PurchaseMembershipResult } from './memberships_service.js';
import { listSlots, type SlotWithBounds } from './slot_service.js';

// ── Browse ───────────────────────────────────────────────────────────────────

export interface PublicVenue {
  id: string;
  name: string;
  tags: string[];
  lat: number | null;
  lng: number | null;
  addressJson: Record<string, unknown> | null;
}

function toPublicVenue(v: Venue): PublicVenue {
  return {
    id: v.id,
    name: v.name,
    tags: v.tags,
    lat: v.lat,
    lng: v.lng,
    addressJson: v.addressJson ?? null,
  };
}

/** Approved + tenant-active venues that have ≥1 bookable arena; optional name/tag search. */
export async function listPublicVenues(opts: { search?: string; limit?: number }): Promise<PublicVenue[]> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const conds = [
    eq(venues.status, 'active'),
    eq(tenants.status, 'active'),
    // Only surface venues a consumer can actually book at (§12.1).
    sql`exists (select 1 from ${arenas} a where a.venue_id = ${venues.id} and a.status = 'active')`,
  ];
  if (opts.search) {
    const like = `%${opts.search.toLowerCase()}%`;
    conds.push(sql`(lower(${venues.name}) like ${like} or exists (
      select 1 from unnest(${venues.tags}) tag where lower(tag) like ${like}
    ))`);
  }
  const rows = await db
    .select({ v: venues })
    .from(venues)
    .innerJoin(tenants, eq(tenants.id, venues.tenantId))
    .where(and(...conds))
    .orderBy(sql`${venues.createdAt} desc`)
    .limit(limit);
  return rows.map((r) => toPublicVenue(r.v));
}

/** A single approved + tenant-active venue, or null. */
export async function getPublicVenue(venueId: string): Promise<Venue | null> {
  const [row] = await db
    .select({ v: venues })
    .from(venues)
    .innerJoin(tenants, eq(tenants.id, venues.tenantId))
    .where(and(eq(venues.id, venueId), eq(venues.status, 'active'), eq(tenants.status, 'active')))
    .limit(1);
  return row?.v ?? null;
}

/** Whether a venue is publicly visible (approved + tenant active). */
async function assertVenueVisible(venueId: string): Promise<Venue> {
  const v = await getPublicVenue(venueId);
  if (!v) throw new NotFound('Venue not found', 'venue_not_found');
  return v;
}

export interface PublicArena {
  id: string;
  name: string;
  sport: string | null;
  capacity: number | null;
  slotDurationMin: number;
  tags: string[];
}

/** Approved arenas for an approved + tenant-active venue. */
export async function listPublicArenas(venueId: string): Promise<PublicArena[]> {
  await assertVenueVisible(venueId);
  const rows = await db
    .select()
    .from(arenas)
    .where(and(eq(arenas.venueId, venueId), eq(arenas.status, 'active')));
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    sport: a.sport,
    capacity: a.capacity,
    slotDurationMin: a.slotDurationMin,
    tags: a.tags,
  }));
}

/** Open (bookable) slots for an arena whose venue is publicly visible. */
export async function listPublicArenaSlots(
  arenaId: string,
  fromIso: string,
  toIso: string,
): Promise<SlotWithBounds[]> {
  // Resolve the arena's venue and confirm both arena + venue are visible.
  const [row] = await db
    .select({ arenaStatus: arenas.status, venueId: arenas.venueId })
    .from(arenas)
    .where(eq(arenas.id, arenaId))
    .limit(1);
  if (!row || row.arenaStatus !== 'active') throw new NotFound('Arena not found', 'arena_not_found');
  await assertVenueVisible(row.venueId);

  const all = await listSlots(arenaId, fromIso, toIso);
  return all.filter((s) => s.status === 'open');
}

/** Published, upcoming events for an approved + tenant-active venue, soonest first. */
export async function listPublicEvents(venueId: string): Promise<Event[]> {
  await assertVenueVisible(venueId);
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.venueId, venueId),
        eq(events.status, 'published'),
        // Hide events that have already ended (§12.2).
        sql`${events.endsAt} >= now()`,
      ),
    )
    .orderBy(sql`${events.startsAt} asc`);
}

/**
 * A public event with a resolved ("effective") location: a venue event reads
 * its location from the venue; a standalone (venue-less) event uses its own
 * columns and the tenant/org name. `loc*` fields are what the UI renders.
 */
export interface PublicEventWithVenue extends Event {
  venueName: string | null;
  venueTags: string[];
  isStandalone: boolean;
  locationName: string;
  locLat: number | null;
  locLng: number | null;
  locTzName: string;
  locAddressJson: Record<string, unknown> | null;
}

interface EventJoinRow {
  e: Event;
  venueName: string | null;
  venueTags: string[] | null;
  venueLat: number | null;
  venueLng: number | null;
  venueTz: string | null;
  venueAddr: Record<string, unknown> | null;
  tenantName: string;
}

function toPublicEvent(r: EventJoinRow): PublicEventWithVenue {
  const isStandalone = r.e.venueId === null;
  return {
    ...r.e,
    venueName: r.venueName,
    venueTags: r.venueTags ?? [],
    isStandalone,
    locationName: r.venueName ?? r.tenantName,
    locLat: isStandalone ? r.e.lat : r.venueLat,
    locLng: isStandalone ? r.e.lng : r.venueLng,
    locTzName: (isStandalone ? r.e.tzName : r.venueTz) ?? 'Asia/Kolkata',
    locAddressJson: isStandalone ? (r.e.addressJson ?? null) : r.venueAddr,
  };
}

const PUBLIC_EVENT_COLUMNS = {
  e: events,
  venueName: venues.name,
  venueTags: venues.tags,
  venueLat: venues.lat,
  venueLng: venues.lng,
  venueTz: venues.tzName,
  venueAddr: venues.addressJson,
  tenantName: tenants.name,
} as const;

/**
 * All published, upcoming events across every visible tenant, soonest first.
 * Venue events require an active venue; org-scoped events have none. Each row
 * carries a resolved location (see toPublicEvent).
 */
export async function listPublicUpcomingEvents(opts: { limit?: number }): Promise<PublicEventWithVenue[]> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const rows = await db
    .select(PUBLIC_EVENT_COLUMNS)
    .from(events)
    .leftJoin(venues, eq(venues.id, events.venueId))
    .innerJoin(tenants, eq(tenants.id, events.tenantId))
    .where(
      and(
        eq(events.status, 'published'),
        eq(tenants.status, 'active'),
        sql`(${events.venueId} is null or ${venues.status} = 'active')`,
        sql`${events.endsAt} >= now()`,
      ),
    )
    .orderBy(sql`${events.startsAt} asc`)
    .limit(limit);
  return (rows as EventJoinRow[]).map(toPublicEvent);
}

/** A single published, upcoming event (venue or standalone) by id, or null. */
export async function getPublicEventById(id: string): Promise<PublicEventWithVenue | null> {
  const [row] = await db
    .select(PUBLIC_EVENT_COLUMNS)
    .from(events)
    .leftJoin(venues, eq(venues.id, events.venueId))
    .innerJoin(tenants, eq(tenants.id, events.tenantId))
    .where(
      and(
        eq(events.id, id),
        eq(events.status, 'published'),
        eq(tenants.status, 'active'),
        sql`(${events.venueId} is null or ${venues.status} = 'active')`,
        sql`${events.endsAt} >= now()`,
      ),
    )
    .limit(1);
  return row ? toPublicEvent(row as EventJoinRow) : null;
}

/** Active memberships (tenant-wide or venue-scoped) for a visible venue. */
export async function listPublicMemberships(venueId: string): Promise<Membership[]> {
  const venue = await assertVenueVisible(venueId);
  return db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, venue.tenantId),
        eq(memberships.status, 'active'),
        sql`(${memberships.venueId} is null or ${memberships.venueId} = ${venueId})`,
      ),
    );
}

/** A public membership enriched with its scope (venue or tenant) for cross-venue cards. */
export interface PublicMembershipWithScope extends Membership {
  /** The owning venue id, or null for tenant-wide memberships. */
  venueId: string | null;
  /** Venue name for venue-scoped; tenant/brand name for tenant-wide. */
  scopeName: string;
  /** Owning venue's tags; empty for tenant-wide (card falls back to motif). */
  venueTags: string[];
}

/**
 * All active memberships across every visible tenant, for the landing
 * "Memberships" row (§12.4). Tenant-wide memberships (venue_id NULL) are kept
 * and labelled with the tenant/brand name; venue-scoped ones require their
 * venue to be active. LEFT JOINs venues so tenant-wide rows survive the join.
 */
export async function listPublicMembershipsAcrossVenues(
  opts: { limit?: number },
): Promise<PublicMembershipWithScope[]> {
  const limit = Math.min(opts.limit ?? 50, 100);
  // Visibility (§12.4): active membership, active tenant, and — only for
  // venue-scoped memberships — an active venue. Tenant-wide rows (venue_id NULL)
  // skip the venue gate; the LEFT JOIN leaves venues.status NULL there, so a bare
  // eq(venues.status,'active') would wrongly drop every tenant-wide membership.
  const conds: SQL[] = [
    eq(memberships.status, 'active'),
    eq(tenants.status, 'active'),
    sql`(${memberships.venueId} is null or ${venues.status} = 'active')`,
  ];
  const rows = await db
    .select({ m: memberships, venueName: venues.name, venueTags: venues.tags, tenantName: tenants.name })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .leftJoin(venues, eq(venues.id, memberships.venueId))
    .where(and(...conds))
    .orderBy(sql`${memberships.createdAt} desc`)
    .limit(limit);
  return rows.map((r) => ({
    ...r.m,
    venueId: r.m.venueId,
    scopeName: r.venueName ?? r.tenantName,
    venueTags: r.venueTags ?? [],
  }));
}

// ── Book / purchase ────────────────────────────────────────────────────────

export interface ConsumerSlotBookingInput {
  slotIds: string[];
  customerName: string;
  customerContact: string;
  note?: string | null;
  actorUserId: string;
}

/**
 * Book + pay for slots as a consumer. Resolves the owning tenant/venue from the
 * slots, confirms the venue is publicly visible, then delegates to the existing
 * online-booking flow (which claims the slots and mints a Razorpay order).
 */
export async function consumerBookSlots(
  input: ConsumerSlotBookingInput,
): Promise<PrepareOnlineBookingResult> {
  if (input.slotIds.length === 0) throw new Conflict('No slots selected', 'no_slots');

  // All slots must belong to one venue/tenant; resolve from the first and
  // verify the rest match (the booking service also asserts single-arena).
  const slotRows = await db
    .select({ id: slots.id, tenantId: slots.tenantId, venueId: arenas.venueId })
    .from(slots)
    .innerJoin(arenas, eq(arenas.id, slots.arenaId))
    .where(inArray(slots.id, input.slotIds));
  if (slotRows.length !== input.slotIds.length) {
    throw new NotFound('Slot not found', 'slot_not_found');
  }
  const tenantId = slotRows[0]!.tenantId;
  const venueId = slotRows[0]!.venueId;
  if (slotRows.some((s) => s.tenantId !== tenantId || s.venueId !== venueId)) {
    throw new Conflict('Slots span multiple venues', 'mixed_venue_slots');
  }

  await assertVenueVisible(venueId);

  return prepareOnlineBookingWithPayment(
    { tenantId, actorUserId: input.actorUserId },
    venueId,
    {
      slotIds: input.slotIds,
      customerName: input.customerName,
      customerContact: input.customerContact,
      note: input.note ?? null,
    },
  );
}

/** Book an event seat as a consumer (event must be published + venue visible). */
export async function consumerBookEvent(
  eventId: string,
  customer: { userId: string; name?: string | null; contact?: string | null },
): Promise<BookEventResult> {
  const [ev] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!ev || ev.status !== 'published') throw new NotFound('Event not found', 'event_not_found');
  // Venue-scoped events gate on venue visibility; org-scoped events have no
  // venue, so gate on the owning tenant being live (mirrors membership purchase).
  if (ev.venueId != null) {
    await assertVenueVisible(ev.venueId);
  } else {
    const [t] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, ev.tenantId))
      .limit(1);
    if (!t || t.status !== 'active') throw new NotFound('Event not found', 'event_not_found');
  }
  return bookEvent(eventId, customer);
}

/** Purchase a membership as a consumer (must be active + tenant visible). */
export async function consumerPurchaseMembership(
  membershipId: string,
  userId: string,
): Promise<PurchaseMembershipResult> {
  const [m] = await db.select().from(memberships).where(eq(memberships.id, membershipId)).limit(1);
  if (!m || m.status !== 'active') throw new NotFound('Membership not found', 'membership_not_found');
  // Confirm the owning tenant is live (membership has no own venue gate when tenant-wide).
  const [t] = await db.select({ status: tenants.status }).from(tenants).where(eq(tenants.id, m.tenantId)).limit(1);
  if (!t || t.status !== 'active') throw new NotFound('Membership not found', 'membership_not_found');
  return purchaseMembership({ membershipId, userId });
}

// ── My bookings ──────────────────────────────────────────────────────────────

export interface MyBookingItem {
  id: string;
  venueId: string | null;
  venueName: string;
  itemType: string;
  status: string;
  totalPaise: number;
  createdAt: string;
}

/**
 * A consumer's own bookings (slots, events, memberships), newest first. LEFT
 * JOINs venues so tenant-wide membership bookings (venue_id NULL) still appear,
 * and falls back to the membership name as the title for those.
 */
export async function listMyBookings(userId: string): Promise<MyBookingItem[]> {
  const raw = await db.execute<Record<string, unknown>>(sql`
    select
      b.id,
      b.venue_id,
      coalesce(v.name, mm.name, 'Booking') as title,
      b.item_type,
      b.status,
      b.total_paise,
      b.created_at
    from bookings b
    left join venues v on v.id = b.venue_id
    left join memberships mm on mm.id = nullif(b.item_data->>'membershipId', '')::uuid
    where b.created_by_user_id = ${userId} or b.customer_user_id = ${userId}
    order by b.created_at desc
    limit 100
  `);
  const rows = raw as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r['id'] as string,
    venueId: (r['venue_id'] as string | null) ?? null,
    venueName: r['title'] as string,
    itemType: r['item_type'] as string,
    status: r['status'] as string,
    totalPaise: Number(r['total_paise']),
    createdAt: new Date(r['created_at'] as string).toISOString(),
  }));
}
