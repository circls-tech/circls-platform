/**
 * Events service — Phase 15.
 *
 * An event occupies one or more arenas during a single window. Booking an event
 * creates `bookings` rows with `item_type='event'`; capacity is enforced at
 * service level (events are seat-based, not slot-based).
 *
 * Authz: routes are responsible for resolving and asserting the actor's tenant
 * membership before reaching this layer. The service trusts its inputs but
 * still validates relational integrity (arenas must belong to the same venue).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { arenas } from '../db/schema/arenas.js';
import { eventArenas, events, type Event, type NewEvent } from '../db/schema/events.js';
import { writeAudit, type AuditCtx } from '../lib/audit.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';

export async function listEventsForVenue(venueId: string): Promise<Event[]> {
  return db.select().from(events).where(eq(events.venueId, venueId));
}

export async function getEvent(eventId: string, tenantId: string): Promise<Event | null> {
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

/** Resolve the arena ids attached to an event. */
export async function getEventArenaIds(eventId: string): Promise<string[]> {
  const rows = await db
    .select({ arenaId: eventArenas.arenaId })
    .from(eventArenas)
    .where(eq(eventArenas.eventId, eventId));
  return rows.map((r) => r.arenaId);
}

export interface CreateEventInput {
  tenantId: string;
  venueId: string;
  name: string;
  description?: string | undefined;
  startsAt: Date;
  endsAt: Date;
  pricePaise: number;
  capacity?: number | undefined;
  arenaIds: string[];
}

/**
 * Create a draft Event with its arenas in a single transaction.
 *
 * Validates:
 *  - startsAt < endsAt
 *  - at least one arenaId
 *  - every arena belongs to the event's venue (and therefore tenant)
 */
export async function createEvent(ctx: AuditCtx, input: CreateEventInput): Promise<Event> {
  if (input.startsAt >= input.endsAt) {
    throw new BadRequest('startsAt must be before endsAt', 'invalid_event_window');
  }
  if (input.arenaIds.length === 0) {
    throw new BadRequest('At least one arena is required', 'no_arenas');
  }

  return db.transaction(async (tx) => {
    // Verify every arena belongs to this event's venue. A mismatched arenaId
    // (deleted, cross-venue, cross-tenant) is rejected before we insert.
    const arenaRows = await tx
      .select({ id: arenas.id, venueId: arenas.venueId })
      .from(arenas)
      .where(inArray(arenas.id, input.arenaIds));

    if (arenaRows.length !== input.arenaIds.length) {
      throw new BadRequest('Unknown arena id', 'unknown_arena');
    }
    if (arenaRows.some((a) => a.venueId !== input.venueId)) {
      throw new BadRequest('Arena does not belong to venue', 'arena_venue_mismatch');
    }

    const [row] = await tx
      .insert(events)
      .values({
        tenantId: input.tenantId,
        venueId: input.venueId,
        name: input.name,
        description: input.description ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        pricePaise: input.pricePaise,
        capacity: input.capacity ?? null,
        status: 'draft',
      })
      .returning();

    if (!row) throw new Error('event insert returned no row');

    await tx
      .insert(eventArenas)
      .values(input.arenaIds.map((arenaId) => ({ eventId: row.id, arenaId })));

    await writeAudit(tx, ctx, 'event.created', 'event', row.id, null, {
      venueId: row.venueId,
      name: row.name,
      arenaIds: input.arenaIds,
      pricePaise: row.pricePaise,
    });

    return row;
  });
}

export interface UpdateEventPatch {
  name?: string;
  description?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  pricePaise?: number;
  capacity?: number | null;
  arenaIds?: string[];
}

/**
 * Update a draft Event. Only allowed when status='draft' — published events
 * are immutable from this surface (cancellation goes through a separate flow).
 * When `arenaIds` is provided, the join rows are replaced atomically.
 */
export async function updateEvent(
  ctx: AuditCtx,
  eventId: string,
  patch: UpdateEventPatch,
): Promise<Event> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenantId)))
      .limit(1);

    if (!existing) throw new NotFound('Event not found', 'event_not_found');
    if (existing.status !== 'draft') {
      throw new Conflict('Only draft events can be edited', 'event_not_draft');
    }

    // Validate the (possibly patched) window.
    const startsAt = patch.startsAt ?? existing.startsAt;
    const endsAt = patch.endsAt ?? existing.endsAt;
    if (startsAt >= endsAt) {
      throw new BadRequest('startsAt must be before endsAt', 'invalid_event_window');
    }

    const set: Partial<NewEvent> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.startsAt !== undefined) set.startsAt = patch.startsAt;
    if (patch.endsAt !== undefined) set.endsAt = patch.endsAt;
    if (patch.pricePaise !== undefined) set.pricePaise = patch.pricePaise;
    if (patch.capacity !== undefined) set.capacity = patch.capacity;

    if (Object.keys(set).length > 0) {
      await tx.update(events).set(set).where(eq(events.id, eventId));
    }

    if (patch.arenaIds !== undefined) {
      if (patch.arenaIds.length === 0) {
        throw new BadRequest('At least one arena is required', 'no_arenas');
      }
      const arenaRows = await tx
        .select({ id: arenas.id, venueId: arenas.venueId })
        .from(arenas)
        .where(inArray(arenas.id, patch.arenaIds));
      if (arenaRows.length !== patch.arenaIds.length) {
        throw new BadRequest('Unknown arena id', 'unknown_arena');
      }
      if (arenaRows.some((a) => a.venueId !== existing.venueId)) {
        throw new BadRequest('Arena does not belong to venue', 'arena_venue_mismatch');
      }
      await tx.delete(eventArenas).where(eq(eventArenas.eventId, eventId));
      await tx
        .insert(eventArenas)
        .values(patch.arenaIds.map((arenaId) => ({ eventId, arenaId })));
    }

    const [updated] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    await writeAudit(tx, ctx, 'event.updated', 'event', eventId, existing as unknown as Record<string, unknown>, {
      ...set,
      ...(patch.arenaIds !== undefined ? { arenaIds: patch.arenaIds } : {}),
    });

    return updated!;
  });
}

/**
 * Transition draft → published. Requires at least one arena row in
 * event_arenas; otherwise the event has no inventory to attach bookings to.
 */
export async function publishEvent(ctx: AuditCtx, eventId: string): Promise<Event> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenantId)))
      .limit(1);
    if (!existing) throw new NotFound('Event not found', 'event_not_found');
    if (existing.status !== 'draft') {
      throw new Conflict('Only draft events can be published', 'event_not_draft');
    }

    const arenaRows = await tx
      .select({ arenaId: eventArenas.arenaId })
      .from(eventArenas)
      .where(eq(eventArenas.eventId, eventId));
    if (arenaRows.length === 0) {
      throw new Conflict('Event has no arenas', 'no_arenas');
    }

    const [updated] = await tx
      .update(events)
      .set({ status: 'published' })
      .where(eq(events.id, eventId))
      .returning();

    await writeAudit(tx, ctx, 'event.published', 'event', eventId, { status: 'draft' }, { status: 'published' });

    return updated!;
  });
}
