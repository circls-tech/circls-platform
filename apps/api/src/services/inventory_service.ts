import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { isExclusionViolation } from '../db/errors.js';
import { type Booking, bookings } from '../db/schema/index.js';
import { Conflict, NotFound } from '../lib/errors.js';

export interface CreateSlotBookingInput {
  tenantId: string;
  venueId?: string | null;
  arenaId: string;
  startAt: string; // ISO
  endAt: string; // ISO
  channel?: 'circls' | 'aggregator' | 'venue_site' | 'walkin';
  paymentMethod?: 'razorpay_route' | 'external' | 'free';
  status?: 'pending' | 'confirmed';
  pricePaise?: number | null;
  customerUserId?: string | null;
  customerContact?: Record<string, unknown> | null;
  createdByUserId: string;
}

/**
 * The single decision-maker for "is this arena free at this moment?". The DB's
 * GIST exclusion constraint is the arbiter: an overlap raises 23P01, which we
 * translate to a 409 `slot_taken`. No app-level locking needed.
 */
export async function createSlotBooking(input: CreateSlotBookingInput): Promise<Booking> {
  try {
    const [booking] = await db
      .insert(bookings)
      .values({
        tenantId: input.tenantId,
        venueId: input.venueId ?? null,
        itemType: 'slot',
        slotArenaId: input.arenaId,
        timeRange: sql`tstzrange(${input.startAt}::timestamptz, ${input.endAt}::timestamptz, '[)')`,
        channel: input.channel ?? 'walkin',
        paymentMethod: input.paymentMethod ?? 'external',
        status: input.status ?? 'confirmed',
        pricePaise: input.pricePaise ?? null,
        customerUserId: input.customerUserId ?? null,
        customerContactJson: input.customerContact ?? null,
        createdByUserId: input.createdByUserId,
      })
      .returning();
    if (!booking) throw new Error('booking insert returned no row');
    return booking;
  } catch (err) {
    if (isExclusionViolation(err)) throw new Conflict('Slot already booked', 'slot_taken');
    throw err;
  }
}

export async function getBookingById(bookingId: string): Promise<Booking | undefined> {
  return db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
}

/** Cancelling flips status; the GIST constraint excludes cancelled rows, freeing the slot. */
export async function cancelBooking(tenantId: string, bookingId: string): Promise<Booking> {
  const [b] = await db
    .update(bookings)
    .set({ status: 'cancelled' })
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .returning();
  if (!b) throw new NotFound('Booking not found', 'booking_not_found');
  return b;
}

/** Bookings on an arena overlapping [from, to) — powers the reception day grid. */
export async function listArenaBookings(
  arenaId: string,
  fromIso: string,
  toIso: string,
): Promise<Booking[]> {
  return db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.slotArenaId, arenaId),
        sql`${bookings.timeRange} && tstzrange(${fromIso}::timestamptz, ${toIso}::timestamptz, '[)')`,
      ),
    );
}
