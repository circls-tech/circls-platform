/**
 * Ticket-tier service. Tiers belong to an event; per-tier sold counts come from
 * event_booking_tickets. Writes are replace-all and only valid while the event
 * is draft (the caller — events_service — enforces draft). All write helpers take
 * a transaction handle so they compose inside the event create/update tx.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { eventBookingTickets } from '../db/schema/event_booking_tickets.js';
import { eventTicketTiers, type EventTicketTier } from '../db/schema/event_ticket_tiers.js';
import { events } from '../db/schema/events.js';
import { bookings } from '../db/schema/bookings.js';
import { BadRequest } from '../lib/errors.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Database = typeof db | Tx;

export interface TierInput {
  name: string;
  description?: string | null;
  pricePaise: number;
  capacity?: number | null;
}

export interface TierWithRemaining extends EventTicketTier {
  sold: number;
  /** capacity - sold, or null when the tier is uncapped. */
  remaining: number | null;
}

/** Live (non-deleted) tiers for an event, ordered for display. */
export async function listTiers(database: Database, eventId: string): Promise<EventTicketTier[]> {
  return database
    .select()
    .from(eventTicketTiers)
    .where(and(eq(eventTicketTiers.eventId, eventId), isNull(eventTicketTiers.deletedAt)))
    .orderBy(eventTicketTiers.sortOrder, eventTicketTiers.createdAt);
}

/** Per-tier sold counts for the given tier ids (non-cancelled bookings only). */
export async function soldByTier(database: Database, tierIds: string[]): Promise<Map<string, number>> {
  if (tierIds.length === 0) return new Map();
  const rows = await database
    .select({
      tierId: eventBookingTickets.tierId,
      sold: sql<number>`coalesce(sum(${eventBookingTickets.quantity}), 0)::int`,
    })
    .from(eventBookingTickets)
    .innerJoin(bookings, eq(bookings.id, eventBookingTickets.bookingId))
    .where(and(inArray(eventBookingTickets.tierId, tierIds), sql`${bookings.status} <> 'cancelled'`))
    .groupBy(eventBookingTickets.tierId);
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.tierId, r.sold);
  return map;
}

/** Live tiers enriched with sold/remaining (for consumer + partner reads). */
export async function listTiersWithRemaining(database: Database, eventId: string): Promise<TierWithRemaining[]> {
  const tiers = await listTiers(database, eventId);
  const sold = await soldByTier(database, tiers.map((t) => t.id));
  return tiers.map((t) => {
    const s = sold.get(t.id) ?? 0;
    return { ...t, sold: s, remaining: t.capacity == null ? null : Math.max(0, t.capacity - s) };
  });
}

/**
 * Replace an event's tiers (draft-only; caller enforces). Soft-deletes tiers no
 * longer present and inserts the provided set fresh. Draft-only means there are no
 * bookings yet, so a clean soft-delete + insert is safe. Returns the new live set.
 */
export async function replaceTiers(tx: Tx, eventId: string, tenantId: string, tiers: TierInput[]): Promise<EventTicketTier[]> {
  if (tiers.length === 0) {
    throw new BadRequest('An event needs at least one ticket tier', 'event_tiers_required');
  }
  await tx
    .update(eventTicketTiers)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(eventTicketTiers.eventId, eventId), isNull(eventTicketTiers.deletedAt)));

  const inserted = await tx
    .insert(eventTicketTiers)
    .values(
      tiers.map((t, i) => ({
        eventId,
        tenantId,
        name: t.name,
        description: t.description ?? null,
        pricePaise: t.pricePaise,
        capacity: t.capacity ?? null,
        sortOrder: i,
      })),
    )
    .returning();

  const minPrice = Math.min(...tiers.map((t) => t.pricePaise));
  await tx.update(events).set({ pricePaise: minPrice }).where(eq(events.id, eventId));

  return inserted;
}
