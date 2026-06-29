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
import { arenas, events, memberships, type MembershipBenefits, tenants, venues } from '../db/schema/index.js';
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

  const raw = await db.execute<Record<string, unknown>>(sql`
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
  }));
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
  // Arena
  sport?: string | null;
  capacity?: number | null;
  slotDurationMin?: number | null;
  // Event
  description?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  pricePaise?: number | null;
  // Membership
  durationDays?: number | null;
  benefits?: MembershipBenefits;
  // Venue link (for arena / membership / venue-scoped event)
  venueId?: string | null;
  venueName?: string | null;
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
          tags: venues.tags,
          status: venues.status,
          createdAt: venues.createdAt,
        })
        .from(venues)
        .innerJoin(tenants, eq(tenants.id, venues.tenantId))
        .where(eq(venues.id, id))
        .limit(1);
      if (!r) return null;
      return { type, ...r, createdAt: r.createdAt.toISOString() };
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
      return {
        type,
        ...r,
        venueName,
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
      return { type, ...r, venueName, createdAt: r.createdAt.toISOString() };
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
