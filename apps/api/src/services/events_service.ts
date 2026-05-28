/**
 * Events service stub — Phase 15 owner fills these in.
 *
 * An event occupies one or more arenas during a single window. Booking an event
 * creates `bookings` rows with `item_type='event'`; capacity is enforced at
 * service level (events are seat-based, not slot-based).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { events, type Event, type NewEvent } from '../db/schema/events.js';

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

export async function createEvent(_input: CreateEventInput): Promise<Event> {
  throw new Error('events_service.createEvent not implemented — phase 15');
}

export async function updateEvent(
  _eventId: string,
  _patch: Partial<NewEvent> & { arenaIds?: string[] },
): Promise<Event> {
  throw new Error('events_service.updateEvent not implemented — phase 15');
}

export async function publishEvent(_eventId: string): Promise<Event> {
  throw new Error('events_service.publishEvent not implemented — phase 15');
}
