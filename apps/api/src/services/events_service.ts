/**
 * Events service — Phase 15 (venue-scoped, subproject C).
 *
 * An event is a venue-level offering during a single window (no arena binding —
 * the `event_arenas` join was dropped in C). Booking an event creates
 * `bookings` rows with `item_type='event'`; capacity is enforced at service
 * level (events are seat-based, not slot-based) and is independent of arena slot
 * inventory.
 *
 * Authz: routes resolve and assert the actor's tenant membership before reaching
 * this layer.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { events, type Event, type NewEvent } from '../db/schema/events.js';
import { writeAudit, type AuditCtx } from '../lib/audit.js';
import { BadRequest, Conflict, NotFound } from '../lib/errors.js';

export interface EventBookingRow {
  id: string;
  customerName: string | null;
  customerContact: string | null;
  status: string;
  totalPaise: number;
  createdAt: string;
}

/**
 * Registrations for an event (partner-facing). Event bookings live in the
 * `bookings` table with item_type='event' and item_data->>'eventId' = the id —
 * they don't appear in the slot/time-window bookings grid, so this is their
 * dedicated read.
 */
export async function listEventBookings(
  tenantId: string,
  eventId: string,
): Promise<EventBookingRow[]> {
  const raw = await db.execute<Record<string, unknown>>(sql`
    select id, customer_name, customer_contact, status, total_paise, created_at
    from bookings
    where tenant_id = ${tenantId}
      and item_type = 'event'
      and item_data->>'eventId' = ${eventId}
    order by created_at desc
    limit 500
  `);
  const rows = raw as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r['id'] as string,
    customerName: (r['customer_name'] as string | null) ?? null,
    customerContact: (r['customer_contact'] as string | null) ?? null,
    status: r['status'] as string,
    totalPaise: Number(r['total_paise']),
    createdAt: new Date(r['created_at'] as string).toISOString(),
  }));
}

export async function listEventsForVenue(venueId: string): Promise<Event[]> {
  return db.select().from(events).where(eq(events.venueId, venueId));
}

/** All events for a tenant (venue-scoped + org-scoped), newest first. */
export async function listEventsForTenant(tenantId: string): Promise<Event[]> {
  return db
    .select()
    .from(events)
    .where(eq(events.tenantId, tenantId))
    .orderBy(sql`${events.createdAt} desc`);
}

export async function getEvent(eventId: string, tenantId: string): Promise<Event | null> {
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, eventId), eq(events.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

export interface CreateEventInput {
  tenantId: string;
  /** Omit for an org-scoped (venue-less) event. */
  venueId?: string | undefined;
  /** Standalone location — required when venueId is omitted. */
  addressJson?: Record<string, unknown> | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
  tzName?: string | undefined;
  name: string;
  description?: string | undefined;
  startsAt: Date;
  endsAt: Date;
  pricePaise: number;
  capacity?: number | undefined;
}

/**
 * Create a draft Event. Venue-scoped when `venueId` is given (location read from
 * the venue); org-scoped when omitted, in which case `addressJson` + `tzName`
 * are required and stored on the event. Validates startsAt < endsAt.
 */
export async function createEvent(ctx: AuditCtx, input: CreateEventInput): Promise<Event> {
  if (input.startsAt >= input.endsAt) {
    throw new BadRequest('startsAt must be before endsAt', 'invalid_event_window');
  }
  const isStandalone = !input.venueId;
  if (isStandalone) {
    if (!input.addressJson) {
      throw new BadRequest('Org-scoped events require an address', 'event_address_required');
    }
    if (!input.tzName) {
      throw new BadRequest('Org-scoped events require a timezone', 'event_tz_required');
    }
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(events)
      .values({
        tenantId: input.tenantId,
        venueId: input.venueId ?? null,
        addressJson: isStandalone ? (input.addressJson ?? null) : null,
        lat: isStandalone ? (input.lat ?? null) : null,
        lng: isStandalone ? (input.lng ?? null) : null,
        tzName: isStandalone ? (input.tzName ?? null) : null,
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

    await writeAudit(tx, ctx, 'event.created', 'event', row.id, null, {
      venueId: row.venueId,
      isStandalone,
      name: row.name,
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
}

/**
 * Update a draft Event. Only allowed when status='draft' — once submitted for
 * review or published the event is immutable from this surface.
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

    const [updated] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);

    await writeAudit(
      tx,
      ctx,
      'event.updated',
      'event',
      eventId,
      existing as unknown as Record<string, unknown>,
      set,
    );

    return updated!;
  });
}

/**
 * Submit a draft event for Circls review: draft → pending_review. (Listing
 * approval, subproject B — the partner's "publish" action hands off to ops, who
 * approve pending_review → published via the admin listings workflow.)
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
      throw new Conflict('Only draft events can be submitted for review', 'event_not_draft');
    }

    const [updated] = await tx
      .update(events)
      .set({ status: 'pending_review' })
      .where(eq(events.id, eventId))
      .returning();

    await writeAudit(tx, ctx, 'event.submitted_for_review', 'event', eventId, { status: 'draft' }, { status: 'pending_review' });

    return updated!;
  });
}

/**
 * Cancel an event (any non-terminal state → cancelled). Idempotent-ish: already
 * cancelled/rejected events are rejected with a 409.
 */
export async function cancelEvent(ctx: AuditCtx, eventId: string): Promise<Event> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.tenantId, ctx.tenantId)))
      .limit(1);
    if (!existing) throw new NotFound('Event not found', 'event_not_found');
    if (existing.status === 'cancelled' || existing.status === 'rejected') {
      throw new Conflict(`Event is already ${existing.status}`, 'event_not_cancellable', {
        status: existing.status,
      });
    }

    const [updated] = await tx
      .update(events)
      .set({ status: 'cancelled' })
      .where(eq(events.id, eventId))
      .returning();

    await writeAudit(tx, ctx, 'event.cancelled', 'event', eventId, { status: existing.status }, { status: 'cancelled' });

    return updated!;
  });
}
