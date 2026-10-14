/**
 * Listing approval (subproject B). Circls reviews each venue / arena / event /
 * membership before it's visible on the consumer portal.
 *
 * Lifecycle (folded into each entity's existing status enum):
 *   venue/arena/membership: pending_review → active (approved) ⇄ suspended/inactive; or rejected
 *   event:                  draft → pending_review → published (approved); or rejected; cancelled
 *
 * Consumer visibility (decision 4): a listing is public iff it is in its
 * approved state AND the owning tenant is not suspended — see `tenantActiveFilter`.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  arenas,
  eventImages,
  events,
  memberships,
  type MembershipBenefits,
  tenants,
  venueImages,
  venues,
  type VenueOpeningHours,
} from '../db/schema/index.js';
import { getStorage } from '../lib/storage.js';
import { listTiers as listEventTiers } from './event_tiers_service.js';
import { listTiers as listMembershipTiers } from './membership_tiers_service.js';
import { Conflict, NotFound } from '../lib/errors.js';
import { writeAudit } from '../lib/audit.js';

export const LISTING_TYPES = ['venue', 'arena', 'event', 'membership'] as const;
export type ListingType = (typeof LISTING_TYPES)[number];

/** Per-type config: the table, its tenant linkage, and the "approved" status. */
const LISTING_CONFIG = {
  venue: { table: venues, approved: 'active' as const },
  arena: { table: arenas, approved: 'active' as const },
  event: { table: events, approved: 'published' as const },
  membership: { table: memberships, approved: 'active' as const },
} satisfies Record<ListingType, { table: unknown; approved: string }>;

/** The status value each entity holds once approved + live. */
export function approvedStatus(type: ListingType): string {
  return LISTING_CONFIG[type].approved;
}

export interface ReviewListingInput {
  type: ListingType;
  id: string;
  actorUserId: string;
}

/**
 * Approve a listing: pending_review → approved (active/published). The owning
 * tenant is recorded on the audit row so it surfaces in that tenant's log.
 */
export async function approveListing(input: ReviewListingInput): Promise<{ id: string; status: string }> {
  return transitionListing(input.type, input.id, input.actorUserId, {
    from: 'pending_review',
    to: approvedStatus(input.type),
    action: 'listing.approved',
  });
}

/** Reject a listing: pending_review → rejected, with an optional reason. */
export async function rejectListing(
  input: ReviewListingInput & { reason?: string },
): Promise<{ id: string; status: string }> {
  return transitionListing(input.type, input.id, input.actorUserId, {
    from: 'pending_review',
    to: 'rejected',
    action: 'listing.rejected',
    ...(input.reason ? { reason: input.reason } : {}),
  });
}

async function transitionListing(
  type: ListingType,
  id: string,
  actorUserId: string,
  opts: { from: string; to: string; action: string; reason?: string },
): Promise<{ id: string; status: string }> {
  // Each listing table shares the shape we need: id, tenant linkage, status.
  // We resolve the owning tenantId (arenas reach it through their venue) so the
  // capability check upstream + the audit row are tenant-scoped.
  return db.transaction(async (tx) => {
    const row = await loadListing(tx, type, id);
    if (!row) throw new NotFound(`${type} not found`, 'listing_not_found');
    if (row.status !== opts.from) {
      throw new Conflict(
        `Only ${opts.from} listings can be ${opts.action.split('.')[1]}`,
        'listing_not_pending',
        { status: row.status },
      );
    }

    const { table } = LISTING_CONFIG[type];
    // drizzle's typed update needs a concrete table; cast through the config.
    await tx
      .update(table as typeof venues)
      .set({ status: opts.to as 'active' })
      .where(eq((table as typeof venues).id, id));

    await writeAudit(
      tx,
      { tenantId: row.tenantId, actorUserId },
      opts.action,
      type,
      id,
      { status: opts.from },
      { status: opts.to, ...(opts.reason ? { reason: opts.reason } : {}) },
    );

    // Recurring events are reviewed as one unit: the decision on one occurrence
    // cascades to every sibling occurrence still awaiting review.
    if (type === 'event') {
      const [ev] = await tx
        .select({ seriesId: events.seriesId })
        .from(events)
        .where(eq(events.id, id))
        .limit(1);
      if (ev?.seriesId) {
        const siblings = await tx
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.seriesId, ev.seriesId),
              eq(events.status, opts.from as 'pending_review'),
              sql`${events.id} <> ${id}`,
            ),
          );
        for (const s of siblings) {
          await tx
            .update(events)
            .set({ status: opts.to as 'published' })
            .where(eq(events.id, s.id));
          await writeAudit(
            tx,
            { tenantId: row.tenantId, actorUserId },
            opts.action,
            type,
            s.id,
            { status: opts.from },
            {
              status: opts.to,
              seriesId: ev.seriesId,
              cascadedFrom: id,
              ...(opts.reason ? { reason: opts.reason } : {}),
            },
          );
        }
      }
    }

    return { id, status: opts.to };
  });
}

interface LoadedListing {
  id: string;
  tenantId: string;
  status: string;
}

/** Load a listing's id/tenantId/status, resolving arena→venue→tenant. */
async function loadListing(
  tx: Pick<typeof db, 'select'>,
  type: ListingType,
  id: string,
): Promise<LoadedListing | null> {
  if (type === 'arena') {
    const [r] = await tx
      .select({ id: arenas.id, tenantId: venues.tenantId, status: arenas.status })
      .from(arenas)
      .innerJoin(venues, eq(venues.id, arenas.venueId))
      .where(eq(arenas.id, id))
      .limit(1);
    return r ?? null;
  }
  const table = LISTING_CONFIG[type].table as typeof venues;
  const [r] = await tx
    .select({ id: table.id, tenantId: table.tenantId, status: table.status })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  return r ?? null;
}

export interface ListingQueueItem {
  type: ListingType;
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  status: string;
  createdAt: string;
  /** Recurring events only: dates in this series with the queried status. */
  seriesCount?: number;
}

/**
 * The review queue for one listing type, newest first. Defaults to
 * pending_review (what ops acts on) but accepts any status for audit views.
 */
export async function listListingsForReview(input: {
  type: ListingType;
  status?: string;
  limit?: number;
}): Promise<ListingQueueItem[]> {
  const status = input.status ?? 'pending_review';
  const limit = Math.min(input.limit ?? 100, 200);
  const { type } = input;

  // Arenas reach the tenant through venues; the others link directly.
  const tenantJoin =
    type === 'arena'
      ? sql`JOIN venues v ON v.id = l.venue_id JOIN tenants t ON t.id = v.tenant_id`
      : sql`JOIN tenants t ON t.id = l.tenant_id`;
  const tableName = sql.raw(`${type}s`); // venue→venues, arena→arenas, …

  // Recurring events queue as one row per series (the earliest date represents
  // it) — the approve/reject decision cascades to the whole series anyway.
  const raw =
    type === 'event'
      ? await db.execute<Record<string, unknown>>(sql`
          SELECT q.* FROM (
            SELECT DISTINCT ON (coalesce(l.series_id, l.id))
              l.id, t.id AS tenant_id, t.name AS tenant_name, l.name, l.status, l.created_at,
              count(*) OVER (PARTITION BY coalesce(l.series_id, l.id))::int AS series_count
            FROM events l
            ${tenantJoin}
            WHERE l.status = ${status}
            ORDER BY coalesce(l.series_id, l.id), l.starts_at ASC
          ) q
          ORDER BY q.created_at DESC, q.id DESC
          LIMIT ${limit}
        `)
      : await db.execute<Record<string, unknown>>(sql`
          SELECT l.id, t.id AS tenant_id, t.name AS tenant_name, l.name, l.status, l.created_at
          FROM ${tableName} l
          ${tenantJoin}
          WHERE l.status = ${status}
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT ${limit}
        `);

  const rows = raw as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    type,
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    tenantName: r['tenant_name'] as string,
    name: r['name'] as string,
    status: r['status'] as string,
    createdAt: new Date(r['created_at'] as string).toISOString(),
    ...(typeof r['series_count'] === 'number' && r['series_count'] > 1
      ? { seriesCount: r['series_count'] }
      : {}),
  }));
}

/**
 * One priced option on an event or membership plan.
 *
 * These are the substance of what a partner configured, and for a long time
 * the review panel could not see them: it read the flat `price_paise` and
 * `capacity` columns on the parent row, which stopped being the source of
 * truth when tiers landed. A reviewer was approving a listing without seeing
 * what it actually sells.
 */
export interface ListingTier {
  id: string;
  name: string;
  description?: string | null;
  pricePaise: number;
  /** Null means uncapped — not zero. */
  capacity: number | null;
  /** Memberships only: how long this tier runs for. */
  durationDays?: number | null;
}

/** A photo on the listing, as the customer would see it. */
export interface ListingImage {
  id: string;
  url: string;
}

export interface ListingDetail {
  type: ListingType;
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  status: string;
  createdAt: string;
  // Venue / standalone-event address
  addressJson?: Record<string, unknown> | null;
  lat?: number | null;
  lng?: number | null;
  tzName?: string | null;
  tags?: string[];
  // Venue profile — all of this is editable in the partner portal, so a
  // reviewer has to be able to read it before approving.
  venueDescription?: string | null;
  amenities?: string[];
  openingHours?: VenueOpeningHours | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  // Arena
  sport?: string | null;
  slotDurationMin?: number | null;
  /**
   * Total seats.
   *
   * For an ARENA this is the column the partner set. For an event or a
   * membership it is derived from the tiers, because that is where capacity
   * actually lives — the parent column is never written and reading it showed
   * an empty field on every listing. Null means uncapped, which for a tiered
   * listing means at least one tier is uncapped.
   */
  capacity?: number | null;
  // Event
  description?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  /**
   * The CHEAPEST tier's price, mirroring the parent column.
   *
   * Kept for compatibility, but on its own it misrepresents a multi-tier
   * listing as costing its floor. Render `priceMinPaise`/`priceMaxPaise`, or
   * the tiers themselves, in preference to this.
   */
  pricePaise?: number | null;
  priceMinPaise?: number | null;
  priceMaxPaise?: number | null;
  /** What the listing actually sells. Empty for venues and arenas. */
  tiers?: ListingTier[];
  /** Recurring events: series grouping + total dates in the series. */
  seriesId?: string | null;
  seriesCount?: number;
  // Membership
  durationDays?: number | null;
  benefits?: MembershipBenefits;
  // Venue link (for arena / membership / venue-scoped event)
  venueId?: string | null;
  venueName?: string | null;
  /** Venue and event photos — part of the listing being judged. */
  images?: ListingImage[];
}

/**
 * Totals across a listing's tiers.
 *
 * Capacity is null when ANY tier is uncapped: an uncapped tier makes the
 * listing as a whole uncapped, and summing the capped ones would report a
 * ceiling that does not exist.
 */
function summariseTiers(tiers: ListingTier[]): {
  capacity: number | null;
  priceMinPaise: number | null;
  priceMaxPaise: number | null;
} {
  if (tiers.length === 0) {
    return { capacity: null, priceMinPaise: null, priceMaxPaise: null };
  }
  const uncapped = tiers.some((t) => t.capacity == null);
  return {
    capacity: uncapped ? null : tiers.reduce((sum, t) => sum + (t.capacity ?? 0), 0),
    priceMinPaise: Math.min(...tiers.map((t) => t.pricePaise)),
    priceMaxPaise: Math.max(...tiers.map((t) => t.pricePaise)),
  };
}

/**
 * An event's tiers, in the order the partner arranged them.
 *
 * Goes through the tiers service rather than the table: tiers are replaced
 * wholesale on every edit and the old rows are soft-deleted, so a raw read
 * would show every tier the partner ever had, not the ones on sale.
 */
async function eventTiers(eventId: string): Promise<ListingTier[]> {
  const rows = await listEventTiers(db, eventId);
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    pricePaise: t.pricePaise,
    capacity: t.capacity,
  }));
}

/** A plan's live tiers. Each carries its own duration, so it is reported per tier. */
async function planTiers(membershipId: string): Promise<ListingTier[]> {
  const rows = await listMembershipTiers(db, membershipId);
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    pricePaise: t.pricePaise,
    capacity: t.capacity,
    durationDays: t.durationDays,
  }));
}

/**
 * Listing photos as public URLs.
 *
 * Storage keys are useless to a reviewer; the point is to SEE the picture the
 * customer will. In stub mode publicUrl still returns something renderable,
 * so this degrades to a broken thumbnail rather than an error.
 */
async function venuePhotos(venueId: string): Promise<ListingImage[]> {
  const rows = await db
    .select({ id: venueImages.id, storageKey: venueImages.storageKey })
    .from(venueImages)
    .where(eq(venueImages.venueId, venueId))
    .orderBy(venueImages.position);
  return rows.map((i) => ({ id: i.id, url: getStorage().publicUrl(i.storageKey) }));
}

async function eventPhotos(eventId: string): Promise<ListingImage[]> {
  const rows = await db
    .select({ id: eventImages.id, storageKey: eventImages.storageKey })
    .from(eventImages)
    .where(eq(eventImages.eventId, eventId))
    .orderBy(eventImages.position);
  return rows.map((i) => ({ id: i.id, url: getStorage().publicUrl(i.storageKey) }));
}

/** Fetch full detail for a single listing, used by the admin review panel. */
export async function getListingDetail(
  type: ListingType,
  id: string,
): Promise<ListingDetail | null> {
  switch (type) {
    case 'venue': {
      const [r] = await db
        .select({
          id: venues.id,
          tenantId: venues.tenantId,
          tenantName: tenants.name,
          name: venues.name,
          addressJson: venues.addressJson,
          lat: venues.lat,
          lng: venues.lng,
          tzName: venues.tzName,
          venueDescription: venues.description,
          amenities: venues.amenities,
          openingHours: venues.openingHours,
          contactPhone: venues.contactPhone,
          contactEmail: venues.contactEmail,
          city: venues.city,
          state: venues.state,
          postalCode: venues.postalCode,
          country: venues.country,
          tags: venues.tags,
          status: venues.status,
          createdAt: venues.createdAt,
        })
        .from(venues)
        .innerJoin(tenants, eq(tenants.id, venues.tenantId))
        .where(eq(venues.id, id))
        .limit(1);
      if (!r) return null;
      return {
        type,
        ...r,
        images: await venuePhotos(id),
        createdAt: r.createdAt.toISOString(),
      };
    }
    case 'arena': {
      const [r] = await db
        .select({
          id: arenas.id,
          tenantId: venues.tenantId,
          tenantName: tenants.name,
          name: arenas.name,
          sport: arenas.sport,
          capacity: arenas.capacity,
          slotDurationMin: arenas.slotDurationMin,
          tags: arenas.tags,
          status: arenas.status,
          createdAt: arenas.createdAt,
          venueId: arenas.venueId,
          venueName: venues.name,
        })
        .from(arenas)
        .innerJoin(venues, eq(venues.id, arenas.venueId))
        .innerJoin(tenants, eq(tenants.id, venues.tenantId))
        .where(eq(arenas.id, id))
        .limit(1);
      if (!r) return null;
      return { type, ...r, createdAt: r.createdAt.toISOString() };
    }
    case 'event': {
      const [r] = await db
        .select({
          id: events.id,
          tenantId: events.tenantId,
          tenantName: tenants.name,
          name: events.name,
          description: events.description,
          startsAt: events.startsAt,
          endsAt: events.endsAt,
          pricePaise: events.pricePaise,
          capacity: events.capacity,
          venueId: events.venueId,
          addressJson: events.addressJson,
          lat: events.lat,
          lng: events.lng,
          tzName: events.tzName,
          seriesId: events.seriesId,
          status: events.status,
          createdAt: events.createdAt,
        })
        .from(events)
        .innerJoin(tenants, eq(tenants.id, events.tenantId))
        .where(eq(events.id, id))
        .limit(1);
      if (!r) return null;
      let venueName: string | null = null;
      if (r.venueId) {
        const [v] = await db
          .select({ name: venues.name })
          .from(venues)
          .where(eq(venues.id, r.venueId))
          .limit(1);
        venueName = v?.name ?? null;
      }
      let seriesCount: number | undefined;
      if (r.seriesId) {
        const [c] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(events)
          .where(eq(events.seriesId, r.seriesId));
        seriesCount = c?.count;
      }
      // `events.capacity` is never written — the create path has no such field
      // and capacity moved to the tiers (see events_service). Reading the
      // column showed an empty capacity on every event in the review panel, so
      // it is derived here and the dead column is dropped from the response.
      const tiers = await eventTiers(r.id);
      const { capacity, priceMinPaise, priceMaxPaise } = summariseTiers(tiers);
      const { capacity: _deadCapacity, ...rest } = r;
      return {
        type,
        ...rest,
        tiers,
        capacity,
        priceMinPaise,
        priceMaxPaise,
        pricePaise: r.pricePaise === null ? null : Number(r.pricePaise),
        images: await eventPhotos(r.id),
        venueName,
        ...(seriesCount !== undefined ? { seriesCount } : {}),
        startsAt: r.startsAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      };
    }
    case 'membership': {
      const [r] = await db
        .select({
          id: memberships.id,
          tenantId: memberships.tenantId,
          tenantName: tenants.name,
          name: memberships.name,
          description: memberships.description,
          pricePaise: memberships.pricePaise,
          durationDays: memberships.durationDays,
          benefits: memberships.benefits,
          venueId: memberships.venueId,
          status: memberships.status,
          createdAt: memberships.createdAt,
        })
        .from(memberships)
        .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
        .where(eq(memberships.id, id))
        .limit(1);
      if (!r) return null;
      let venueName: string | null = null;
      if (r.venueId) {
        const [v] = await db
          .select({ name: venues.name })
          .from(venues)
          .where(eq(venues.id, r.venueId))
          .limit(1);
        venueName = v?.name ?? null;
      }
      // Same story as events: a plan's real prices, durations and seat caps are
      // per tier, and `memberships.price_paise` only mirrors the cheapest one.
      const tiers = await planTiers(r.id);
      const { capacity, priceMinPaise, priceMaxPaise } = summariseTiers(tiers);
      return {
        type,
        ...r,
        tiers,
        capacity,
        priceMinPaise,
        priceMaxPaise,
        pricePaise: r.pricePaise === null ? null : Number(r.pricePaise),
        venueName,
        createdAt: r.createdAt.toISOString(),
      };
    }
  }
}

/**
 * SQL predicate for "the owning tenant is operationally live" — i.e. not
 * suspended. Consumer reads AND this with the listing's approved status.
 * Exposed for subproject E (consumer portal) to compose into its queries.
 */
export function tenantActiveFilter(tenantStatusCol: unknown) {
  return sql`${tenantStatusCol} = 'active'`;
}
