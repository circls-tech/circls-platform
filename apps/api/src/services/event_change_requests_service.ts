/**
 * Event change requests — admin-approved edits to PUBLISHED events.
 *
 * Free live edits (description, QR config, questions, per-customer limit,
 * capacity increases) go straight through `updateEvent`/`applyLiveSettings` and
 * never touch this service. The approval-gated fields (name, window, location,
 * tiers) are stored here as a jsonb patch; circls ops approve (apply) or
 * reject them from the admin review queue. At most one pending request per
 * event — enforced by the partial unique index
 * `event_change_requests_pending_uq`, not by racy pre-selects.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import {
  eventChangeRequests,
  type EventChangeRequest,
  type EventChangeRequestPatch,
  type EventChangeRequestSnapshot,
} from '../db/schema/event_change_requests.js';
import { events, type Event } from '../db/schema/events.js';
import { tenants } from '../db/schema/tenants.js';
import { writeAudit, type AuditCtx } from '../lib/audit.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';
import {
  listTiers,
  listTiersWithRemaining,
  soldByTier,
  type LiveTierInput,
  type TierWithRemaining,
} from './event_tiers_service.js';
import {
  applyApprovedChangePatch,
  prepareEventPatch,
  type UpdateEventPatch,
} from './events_service.js';
import { getVenueById } from './venue_service.js';

const PATCH_KEYS = [
  'name',
  'startsAt',
  'endsAt',
  'venueId',
  'addressJson',
  'lat',
  'lng',
  'tzName',
  'tiers',
] as const;

const LOCATION_KEYS = new Set(['venueId', 'addressJson', 'lat', 'lng', 'tzName']);

/** The patch's defined keys — what the request proposes to change. */
export function patchedFields(patch: EventChangeRequestPatch): string[] {
  return PATCH_KEYS.filter((k) => patch[k] !== undefined);
}

/** Stored ISO-string patch → the Date-typed patch the events service applies. */
function toUpdatePatch(patch: EventChangeRequestPatch): UpdateEventPatch {
  const out: UpdateEventPatch = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.startsAt !== undefined) out.startsAt = new Date(patch.startsAt);
  if (patch.endsAt !== undefined) out.endsAt = new Date(patch.endsAt);
  if (patch.venueId !== undefined) out.venueId = patch.venueId;
  if (patch.addressJson !== undefined) out.addressJson = patch.addressJson;
  if (patch.lat !== undefined) out.lat = patch.lat;
  if (patch.lng !== undefined) out.lng = patch.lng;
  if (patch.tzName !== undefined) out.tzName = patch.tzName;
  if (patch.tiers !== undefined) out.tiers = patch.tiers as LiveTierInput[];
  return out;
}

/**
 * Fail-fast validation of a proposed patch against the event's CURRENT state.
 * Everything here is re-checked at approve time (the event may change in
 * between); this exists so partners get errors at submit, not days later.
 */
async function validatePatchAgainstEvent(
  database: typeof db,
  event: Event,
  patch: EventChangeRequestPatch,
): Promise<void> {
  const startsAt = patch.startsAt !== undefined ? new Date(patch.startsAt) : event.startsAt;
  const endsAt = patch.endsAt !== undefined ? new Date(patch.endsAt) : event.endsAt;
  if (startsAt >= endsAt) {
    throw new BadRequest('startsAt must be before endsAt', 'invalid_event_window');
  }

  const targetVenueId = patch.venueId !== undefined ? patch.venueId : event.venueId;
  if (!targetVenueId) {
    const addressJson = patch.addressJson ?? event.addressJson;
    const tzName = patch.tzName ?? event.tzName;
    if (!addressJson || Object.keys(addressJson).length === 0) {
      throw new BadRequest('Standalone events require a non-empty address', 'event_address_required');
    }
    if (!tzName) {
      throw new BadRequest('Standalone events require a timezone', 'event_tz_required');
    }
  }

  if (patch.tiers !== undefined) {
    if (patch.tiers.length === 0) {
      throw new BadRequest('An event needs at least one ticket tier', 'event_tiers_required');
    }
    const live = await listTiers(database, event.id);
    const liveById = new Map(live.map((t) => [t.id, t]));
    const sold = await soldByTier(database, live.map((t) => t.id));
    const keptIds = new Set<string>();
    for (const t of patch.tiers) {
      if (!t.id) continue;
      if (!liveById.has(t.id)) {
        throw new BadRequest('Unknown ticket tier for this event', 'bad_request', { tierId: t.id });
      }
      keptIds.add(t.id);
      const capacity = t.capacity ?? null;
      const soldCount = sold.get(t.id) ?? 0;
      if (capacity !== null && capacity < soldCount) {
        throw new Conflict(
          'Tier capacity cannot go below tickets already sold',
          'tier_capacity_below_sold',
          { tierId: t.id, sold: soldCount, requested: capacity },
        );
      }
    }
    for (const t of live) {
      const soldCount = sold.get(t.id) ?? 0;
      if (!keptIds.has(t.id) && soldCount > 0) {
        throw new Conflict(
          'Cannot remove a tier that already has registrations',
          'tier_has_bookings',
          { tierId: t.id, sold: soldCount },
        );
      }
    }
  }
}

/** The event's current values of the patched keys (location snapshots as a
 *  cluster — a venue/address change is only interpretable with all five). */
async function buildSnapshot(
  event: Event,
  patch: EventChangeRequestPatch,
): Promise<EventChangeRequestSnapshot> {
  const snapshot: EventChangeRequestSnapshot = {};
  if (patch.name !== undefined) snapshot.name = event.name;
  if (patch.startsAt !== undefined) snapshot.startsAt = event.startsAt.toISOString();
  if (patch.endsAt !== undefined) snapshot.endsAt = event.endsAt.toISOString();
  if (patchedFields(patch).some((k) => LOCATION_KEYS.has(k))) {
    snapshot.venueId = event.venueId;
    snapshot.addressJson = event.addressJson;
    snapshot.lat = event.lat;
    snapshot.lng = event.lng;
    snapshot.tzName = event.tzName;
  }
  if (patch.tiers !== undefined) {
    const live = await listTiers(db, event.id);
    snapshot.tiers = live.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      pricePaise: t.pricePaise,
      capacity: t.capacity,
      qrTicketConfig: t.qrTicketConfig,
    }));
  }
  return snapshot;
}

/**
 * Partner: propose a change to a published event. The route has already
 * validated the payload shape and (for `venueId`) tenant ownership.
 */
export async function createChangeRequest(
  ctx: AuditCtx,
  eventId: string,
  patch: EventChangeRequestPatch,
): Promise<EventChangeRequest> {
  if (patchedFields(patch).length === 0) {
    throw new BadRequest('A change request needs at least one field', 'bad_request');
  }

  const [event] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenantId)))
    .limit(1);
  if (!event) throw new NotFound('Event not found', 'event_not_found');
  if (event.status !== 'published') {
    throw new Conflict(
      'Change requests are for live events — drafts are edited directly',
      'event_not_published',
      { status: event.status },
    );
  }

  await validatePatchAgainstEvent(db, event, patch);
  const snapshot = await buildSnapshot(event, patch);

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(eventChangeRequests)
        .values({
          eventId,
          tenantId: ctx.tenantId,
          requestedBy: ctx.actorUserId,
          patch,
          snapshot,
        })
        .returning();
      await writeAudit(tx, ctx, 'event.change_requested', 'event_change_request', row!.id, null, {
        eventId,
        fields: patchedFields(patch),
      });
      return row!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Conflict(
        'This event already has a pending change request — withdraw it to submit a new one',
        'change_request_pending',
      );
    }
    throw err;
  }
}

/** Partner: this event's change requests, newest first (banner + history). */
export async function listChangeRequests(
  tenantId: string,
  eventId: string,
): Promise<EventChangeRequest[]> {
  return db
    .select()
    .from(eventChangeRequests)
    .where(and(eq(eventChangeRequests.eventId, eventId), eq(eventChangeRequests.tenantId, tenantId)))
    .orderBy(desc(eventChangeRequests.createdAt))
    .limit(50);
}

/** Partner: withdraw a pending request, freeing the one-pending slot. */
export async function withdrawChangeRequest(
  ctx: AuditCtx,
  requestId: string,
): Promise<EventChangeRequest> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(eventChangeRequests)
      .set({ status: 'withdrawn' })
      .where(
        and(
          eq(eventChangeRequests.id, requestId),
          eq(eventChangeRequests.tenantId, ctx.tenantId),
          eq(eventChangeRequests.status, 'pending'),
        ),
      )
      .returning();
    if (!row) {
      const [existing] = await tx
        .select()
        .from(eventChangeRequests)
        .where(
          and(
            eq(eventChangeRequests.id, requestId),
            eq(eventChangeRequests.tenantId, ctx.tenantId),
          ),
        )
        .limit(1);
      if (!existing) throw new NotFound('Change request not found', 'change_request_not_found');
      throw new Conflict(
        'This change request is no longer pending',
        'change_request_not_pending',
        { status: existing.status },
      );
    }
    await writeAudit(
      tx,
      ctx,
      'event.change_withdrawn',
      'event_change_request',
      row.id,
      { status: 'pending' },
      { status: 'withdrawn' },
    );
    return row;
  });
}

export interface ChangeRequestQueueItem {
  id: string;
  eventId: string;
  tenantId: string;
  tenantName: string;
  eventName: string;
  eventStartsAt: string;
  fields: string[];
  createdAt: string;
}

/** Admin: the pending review queue, newest first. */
export async function listChangeRequestsForReview(input?: {
  limit?: number;
}): Promise<ChangeRequestQueueItem[]> {
  const limit = Math.min(input?.limit ?? 100, 200);
  const rows = await db
    .select({
      id: eventChangeRequests.id,
      eventId: eventChangeRequests.eventId,
      tenantId: eventChangeRequests.tenantId,
      tenantName: tenants.name,
      eventName: events.name,
      eventStartsAt: events.startsAt,
      patch: eventChangeRequests.patch,
      createdAt: eventChangeRequests.createdAt,
    })
    .from(eventChangeRequests)
    .innerJoin(events, eq(events.id, eventChangeRequests.eventId))
    .innerJoin(tenants, eq(tenants.id, eventChangeRequests.tenantId))
    .where(eq(eventChangeRequests.status, 'pending'))
    .orderBy(desc(eventChangeRequests.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    tenantId: r.tenantId,
    tenantName: r.tenantName,
    eventName: r.eventName,
    eventStartsAt: r.eventStartsAt.toISOString(),
    fields: patchedFields(r.patch),
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface ChangeRequestDetail {
  id: string;
  status: string;
  patch: EventChangeRequestPatch;
  snapshot: EventChangeRequestSnapshot;
  reason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  tenantId: string;
  tenantName: string;
  /** The proposed venue's name when the patch re-scopes to a venue. */
  proposedVenueName: string | null;
  event: {
    id: string;
    name: string;
    status: string;
    startsAt: string;
    endsAt: string;
    venueId: string | null;
    venueName: string | null;
    addressJson: Record<string, unknown> | null;
    tzName: string | null;
    /** Current live tiers with sold counts — shows the admin what a removal
     *  or capacity decrease is up against. */
    tiers: TierWithRemaining[];
  };
}

/** Admin: full detail for the review panel — request + the event's CURRENT
 *  values (re-read now, so staleness vs `snapshot` is visible). */
export async function getChangeRequestDetail(id: string): Promise<ChangeRequestDetail | null> {
  const [row] = await db
    .select({
      request: eventChangeRequests,
      event: events,
      tenantName: tenants.name,
    })
    .from(eventChangeRequests)
    .innerJoin(events, eq(events.id, eventChangeRequests.eventId))
    .innerJoin(tenants, eq(tenants.id, eventChangeRequests.tenantId))
    .where(eq(eventChangeRequests.id, id))
    .limit(1);
  if (!row) return null;

  const { request, event } = row;
  const tiers = await listTiersWithRemaining(db, event.id);
  const currentVenue = event.venueId ? await getVenueById(event.venueId) : undefined;
  const proposedVenue = request.patch.venueId ? await getVenueById(request.patch.venueId) : undefined;

  return {
    id: request.id,
    status: request.status,
    patch: request.patch,
    snapshot: request.snapshot,
    reason: request.reason,
    createdAt: request.createdAt.toISOString(),
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    tenantId: request.tenantId,
    tenantName: row.tenantName,
    proposedVenueName: proposedVenue?.name ?? null,
    event: {
      id: event.id,
      name: event.name,
      status: event.status,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      venueId: event.venueId,
      venueName: currentVenue?.name ?? null,
      addressJson: event.addressJson,
      tzName: event.tzName,
      tiers,
    },
  };
}

/**
 * Admin: approve — apply the patch to the (still-published) event and mark the
 * request approved, atomically. Any apply failure (event cancelled since,
 * tier now has bookings, capacity below sold, venue deleted) rolls the whole
 * transaction back, so the request STAYS PENDING and the partner can withdraw
 * and resubmit.
 */
export async function approveChangeRequest(input: {
  id: string;
  actorUserId: string;
}): Promise<{ id: string; status: string }> {
  const [request] = await db
    .select()
    .from(eventChangeRequests)
    .where(eq(eventChangeRequests.id, input.id))
    .limit(1);
  if (!request) throw new NotFound('Change request not found', 'change_request_not_found');
  if (request.status !== 'pending') {
    throw new Conflict('This change request is no longer pending', 'change_request_not_pending', {
      status: request.status,
    });
  }

  // Re-geocode/canonicalize outside the tx (may hit the network), exactly as a
  // direct edit would.
  const patch = await prepareEventPatch(toUpdatePatch(request.patch));

  // The proposed venue must still exist and belong to the requesting tenant.
  if (patch.venueId) {
    const venue = await getVenueById(patch.venueId);
    if (!venue || venue.tenantId !== request.tenantId) {
      throw new Conflict(
        'The proposed venue no longer exists — ask the partner to resubmit',
        'change_request_stale',
        { venueId: patch.venueId },
      );
    }
  }

  const ctx: AuditCtx = { tenantId: request.tenantId, actorUserId: input.actorUserId };
  return db.transaction(async (tx) => {
    // Conditional flip closes the concurrent approve/reject/withdraw race.
    const [flipped] = await tx
      .update(eventChangeRequests)
      .set({ status: 'approved', reviewedBy: input.actorUserId, reviewedAt: sql`now()` })
      .where(and(eq(eventChangeRequests.id, input.id), eq(eventChangeRequests.status, 'pending')))
      .returning();
    if (!flipped) {
      throw new Conflict('This change request is no longer pending', 'change_request_not_pending');
    }

    const [event] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, request.eventId), eq(events.tenantId, request.tenantId)))
      .limit(1);
    if (!event) throw new NotFound('Event not found', 'event_not_found');
    if (event.status !== 'published') {
      throw new Conflict(
        'The event is no longer live — the change cannot be applied',
        'event_not_published',
        { status: event.status },
      );
    }

    await applyApprovedChangePatch(tx, ctx, event, patch);

    await writeAudit(
      tx,
      ctx,
      'event.change_approved',
      'event_change_request',
      request.id,
      request.snapshot as unknown as Record<string, unknown>,
      request.patch as unknown as Record<string, unknown>,
    );

    return { id: request.id, status: 'approved' };
  });
}

/** Admin: reject with an optional reason the partner sees in their banner. */
export async function rejectChangeRequest(input: {
  id: string;
  actorUserId: string;
  reason?: string;
}): Promise<{ id: string; status: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(eventChangeRequests)
      .set({
        status: 'rejected',
        reason: input.reason ?? null,
        reviewedBy: input.actorUserId,
        reviewedAt: sql`now()`,
      })
      .where(and(eq(eventChangeRequests.id, input.id), eq(eventChangeRequests.status, 'pending')))
      .returning();
    if (!row) {
      const [existing] = await tx
        .select()
        .from(eventChangeRequests)
        .where(eq(eventChangeRequests.id, input.id))
        .limit(1);
      if (!existing) throw new NotFound('Change request not found', 'change_request_not_found');
      throw new Conflict('This change request is no longer pending', 'change_request_not_pending', {
        status: existing.status,
      });
    }
    const ctx: AuditCtx = { tenantId: row.tenantId, actorUserId: input.actorUserId };
    await writeAudit(
      tx,
      ctx,
      'event.change_rejected',
      'event_change_request',
      row.id,
      { status: 'pending' },
      { status: 'rejected', ...(input.reason ? { reason: input.reason } : {}) },
    );
    return { id: row.id, status: 'rejected' };
  });
}
